import { describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fixtureRepo, tmp } from "./helpers.ts"

const PLUGIN_ROOT = join(import.meta.dir, "..")

describe("hooks/run.sh", () => {
    test("does not let the repository's own .env configure the plugin", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "a.ts": "x\n" }, "a")
        // If Bun loaded this, the hook would run in dry-run mode and write a patch instead of complaining.
        writeFileSync(join(repo.work, ".env"), "AMPLIFY_DRY_RUN=1\nAMPLIFY_API_KEY=from-repo-env\n")
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
        const proc = Bun.spawn(["bash", join(PLUGIN_ROOT, "hooks", "run.sh"), "commit"], { cwd: repo.work, env, stdin: new Blob([payload]), stdout: "pipe", stderr: "pipe" })
        const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

        expect(code).toBe(2)
        expect(stdout).toContain("not configured")
        expect(existsSync(join(dataDir, "dry-run"))).toBe(false)
    })
})
