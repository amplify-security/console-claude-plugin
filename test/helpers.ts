import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function run(cwd: string, cmd: string[]): string {
    const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
    if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${proc.stderr.toString()}`)
    return proc.stdout.toString().trim()
}

export function tmp(prefix = "amplify-test-"): string {
    return mkdtempSync(join(tmpdir(), prefix))
}

/** A working repo with a hosted-looking `origin`, a local bare remote it pushes to, one pushed commit, and helpers to add more. */
export function fixtureRepo() {
    const remote = tmp("remote-")
    run(remote, ["git", "init", "--bare", "-q", "-b", "main"])
    const work = tmp("work-")
    run(work, ["git", "init", "-q", "-b", "main"])
    run(work, ["git", "config", "user.email", "t@example.com"])
    run(work, ["git", "config", "user.name", "Test"])
    // `origin` looks hosted (what the Amplify project stores); pushes go to a local bare remote.
    run(work, ["git", "remote", "add", "origin", "https://github.com/acme/app.git"])
    run(work, ["git", "remote", "add", "local", remote])

    const commit = (files: Record<string, string>, message: string): string => {
        for (const [path, content] of Object.entries(files)) {
            const full = join(work, path)
            Bun.spawnSync(["mkdir", "-p", join(full, "..")])
            require("node:fs").writeFileSync(full, content)
        }
        run(work, ["git", "add", "-A"])
        run(work, ["git", "commit", "-q", "-m", message])
        return run(work, ["git", "rev-parse", "HEAD"])
    }
    const push = () => run(work, ["git", "push", "-q", "-u", "local", "main"])

    const first = commit({ "README.md": "hello\n" }, "init")
    push()
    return { work, remote, commit, push, first }
}
