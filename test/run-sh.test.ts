import { describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fixtureRepo, tmp } from "./helpers.ts"

const PLUGIN_ROOT = join(import.meta.dir, "..")

describe("hooks/run.sh", () => {
    test("does not let the repository's own .env or bunfig.toml configure the plugin or run code", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "a.ts": "x\n" }, "a")
        // If Bun loaded this, the hook would run in dry-run mode and write a patch instead of complaining.
        writeFileSync(join(repo.work, ".env"), "AMPLIFY_DRY_RUN=1\nAMPLIFY_API_KEY=from-repo-env\n")
        // If Bun read this, the preload would run inside the hook process before main.ts.
        writeFileSync(join(repo.work, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
        writeFileSync(join(repo.work, "preload.ts"), 'console.log("PRELOAD RAN")\n')
        const dataDir = tmp()

        const env: Record<string, string> = { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: dataDir }
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("AMPLIFY_") && !(k in env)) env[k] = v
        const payload = JSON.stringify({
            session_id: "s-env",
            cwd: repo.work,
            hook_event_name: "PostToolUse",
            tool_name: "Bash",
            tool_input: { command: "git commit -m a" },
            tool_response: { stdout: `[main ${head.slice(0, 7)}] a` },
        })
        // The synchronous hook is the one that reports an unconfigured plugin.
        const proc = Bun.spawn(["bash", join(PLUGIN_ROOT, "hooks", "run.sh"), "commit-start"], { cwd: repo.work, env, stdin: new Blob([payload]), stdout: "pipe", stderr: "pipe" })
        const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

        expect(code).toBe(0)
        expect(stdout).toContain("not configured")
        expect(stdout).not.toContain("PRELOAD RAN")
        expect(existsSync(join(dataDir, "dry-run"))).toBe(false)
    })

    test("without Bun, only the synchronous commit-start hook, and only for a commit, reports the unchecked commit, every time", async () => {
        const dataDir = tmp()
        const env: Record<string, string> = { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: dataDir, PATH: "/usr/bin:/bin", HOME: tmp() }
        const runHook = async (trigger: string, command: string) => {
            const payload = JSON.stringify({ session_id: "s", cwd: "/", tool_name: "Bash", tool_input: { command } })
            const proc = Bun.spawn(["bash", join(PLUGIN_ROOT, "hooks", "run.sh"), trigger], { env, stdin: new Blob([payload]), stdout: "pipe", stderr: "pipe" })
            const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
            return { stdout, code }
        }
        // The hook is gated on any git command: a non-commit says nothing.
        expect(await runHook("commit-start", "git -C packages/api log --oneline")).toEqual({ stdout: "", code: 0 })
        // The async hook runs in parallel with the sync one; its exit-0 output would be dropped anyway.
        expect(await runHook("commit", 'git commit -m "x"')).toEqual({ stdout: "", code: 0 })
        for (const command of ['cd app && git commit -m "x"', 'git commit -m "y"']) {
            const syncHook = await runHook("commit-start", command)
            expect(syncHook.code).toBe(0)
            const output = JSON.parse(syncHook.stdout)
            expect(output.systemMessage).toContain("was not checked because Bun is not installed")
            expect(output.hookSpecificOutput.additionalContext).toContain("Mention this to the user")
        }
    })
})
