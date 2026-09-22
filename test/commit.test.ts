import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { announceCommitCheck, commitStartDir, MAX_DIFF_FILES, recordPreCommitHead, runCommitCheck } from "../src/commit.ts"
import type { HookInput } from "../src/hook-io.ts"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { gitDir } from "../src/git.ts"
import { readCheckedShas, readPreCommitHead } from "../src/state.ts"
import { fixtureRepo, run, tmp } from "./helpers.ts"

const env = (dataDir: string, extra: Record<string, string> = {}) => ({
    CLAUDE_PLUGIN_DATA: dataDir,
    AMPLIFY_API_KEY: "key",
    AMPLIFY_ORG_ID: "org_1",
    AMPLIFY_API_URL: "https://api.test",
    ...extra,
})

const input = (cwd: string, sha: string, session = "s1"): HookInput => ({
    session_id: session,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "git commit -m 'x'" },
    tool_response: { stdout: `[main ${sha.slice(0, 7)}] x\n 1 file changed, 1 insertion(+)` },
})

interface FakeServer {
    calls: Array<{ method: string; url: string; body?: unknown }>
    fetchImpl: (url: string, init: RequestInit) => Promise<Response>
}

/** A fake Amplify API: memberships, project lookup, run submit, long-poll, findings. */
function fakeServer(opts: { project?: string | null; statuses?: string[]; findings?: unknown[]; orgs?: string[] } = {}): FakeServer {
    const statuses = [...(opts.statuses ?? ["running", "completed"])]
    const calls: FakeServer["calls"] = []
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    return {
        calls,
        fetchImpl: async (url, init) => {
            const body = init.body ? JSON.parse(init.body as string) : undefined
            calls.push({ method: init.method ?? "GET", url, body })
            const path = new URL(url).pathname
            if (path === "/v1.1/user/memberships") {
                if (!(init.headers as Record<string, string>)["X-Amplify-Api-Key"]) return json({ error: "unauthorized" }, 401)
                const orgs = opts.orgs ?? ["org_1"]
                return json({ data: orgs.map((id) => ({ id: `m_${id}`, organization: { id, name: id.toUpperCase() } })), total_count: orgs.length })
            }
            if (path === "/api/projects") return json(opts.project === null ? [] : [{ id: opts.project ?? "p1" }])
            if (path === "/api/runs") return json({ runId: "run_1" }, 202)
            if (path.startsWith("/api/runs/")) {
                const status = statuses.length > 1 ? statuses.shift() : statuses[0]
                return json({ id: "run_1", status, error: status === "error" ? "diff did not apply cleanly" : null })
            }
            if (path === "/api/findings") return json({ data: opts.findings ?? [], total: (opts.findings ?? []).length, limit: 100, offset: 0 })
            return json({ error: "NOT_FOUND", message: path }, 404)
        },
    }
}

const finding = (file: string, line: number) => ({
    id: `f-${file}-${line}`,
    detectionId: "det",
    filePath: file,
    raw: {
        ruleId: "rule",
        level: "error",
        message: { text: "bad" },
        locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: line } } }],
    },
})

/** Capture what the hook prints to stdout. */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
    const original = process.stdout.write.bind(process.stdout)
    let out = ""
    process.stdout.write = ((chunk: string | Uint8Array) => {
        out += chunk.toString()
        return true
    }) as typeof process.stdout.write
    try {
        return { result: await fn(), out }
    } finally {
        process.stdout.write = original
    }
}

const fast = { now: Date.now, sleep: async () => {} }

describe("commitStartDir", () => {
    const cwd = "/work"
    test("recognizes a commit after -C/-c options, quoted or not, and applies the -C directories", () => {
        expect(commitStartDir("git commit -m x", cwd)).toBe("/work")
        expect(commitStartDir('git -C "/Users/me/My Repo" commit -m x', cwd)).toBe("/Users/me/My Repo")
        expect(commitStartDir("git -c user.name='Foo Bar' -C sub commit", cwd)).toBe("/work/sub")
        expect(commitStartDir('git -c user.name="Foo Bar" commit -m x', cwd)).toBe("/work")
        expect(commitStartDir("git -C a -C b commit", cwd)).toBe("/work/a/b")
    })
    test("follows a cd in an earlier subcommand", () => {
        expect(commitStartDir("cd app && git add -A && git commit -m x", cwd)).toBe("/work/app")
        expect(commitStartDir('cd "my app"; git commit -m x', cwd)).toBe("/work/my app")
        expect(commitStartDir("cd /elsewhere && cd sub && git -C deeper commit", cwd)).toBe("/elsewhere/sub/deeper")
        expect(commitStartDir("cd ~/proj && git commit -m x", cwd, "/home/me")).toBe("/home/me/proj")
        expect(commitStartDir("cd && git commit -m x", cwd, "/home/me")).toBe("/home/me")
    })
    test("returns null when no subcommand is a git commit", () => {
        expect(commitStartDir("git status", cwd)).toBeNull()
        expect(commitStartDir("cd app && git status", cwd)).toBeNull()
        expect(commitStartDir("git commit-tree HEAD^{tree} -m x", cwd)).toBeNull()
    })
})

describe("runCommitCheck", () => {
    test("submits the unpushed diff, waits, and wakes Claude with in-scope findings", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "src/a.ts": "line1\nline2\n" }, "add a")
        const server = fakeServer({ findings: [finding("src/a.ts", 2), finding("README.md", 1)] })
        const dataDir = tmp()

        const { result, out } = await capture(() =>
            runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast })
        )

        expect(result).toBe(2)
        const submit = server.calls.find((c) => c.url.endsWith("/api/runs"))!
        expect(submit.body).toMatchObject({ agentName: "detections-runner", projectId: "p1", source: { baseSha: repo.first } })
        expect((submit.body as { source: { diff: string } }).source.diff).toContain("+++ b/src/a.ts")
        expect(server.calls.some((c) => c.url.includes("/api/runs/run_1?wait=30"))).toBe(true)
        expect(server.calls.some((c) => c.url.includes("/api/findings?agentRunId=run_1"))).toBe(true)

        const output = JSON.parse(out.trim().split("\n").at(-1)!)
        expect(output.rewakeSummary).toBe("Amplify Console: 1 high in 1 file")
        expect(output.hookSpecificOutput.additionalContext).toContain("src/a.ts:2")
        expect(output.hookSpecificOutput.additionalContext).not.toContain("README.md")
        expect(readCheckedShas(join(repo.work, ".git")).all.has(head)).toBe(true)
    })

    test("uses the parent as base after `git commit && git push`, and reports a clean commit with a one-line wake", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "b.ts": "x\n" }, "b")
        repo.push()
        const server = fakeServer()
        const { result, out } = await capture(() =>
            runCommitCheck(input(repo.work, head), { env: env(tmp()), fetchImpl: server.fetchImpl, ...fast })
        )
        expect(result).toBe(2)
        expect(server.calls.find((c) => c.url.endsWith("/api/runs"))!.body).toMatchObject({ source: { baseSha: repo.first } })
        const output = JSON.parse(out.trim())
        expect(output.rewakeSummary).toBe(`Amplify Console: no findings in commit ${head.slice(0, 7)}`)
        expect(plain(output.hookSpecificOutput.additionalContext)).toContain("found nothing")
        expect(output.hookSpecificOutput.additionalContext).toContain("Tell the user in one sentence")
    })

    test("resolves the repo root when the hook fires from a subdirectory, so the diff isn't scoped to it", async () => {
        const repo = fixtureRepo()
        run(repo.work, ["mkdir", "-p", "sub"])
        writeFileSync(join(repo.work, "img.bin"), Buffer.from([0, 1, 2, 3, 0, 255]))
        const head = repo.commit({ "sub/x.ts": "line1\n", "outside.ts": "line1\n" }, "add across subdir")
        const subDir = join(repo.work, "sub")
        const server = fakeServer()

        await capture(() => runCommitCheck(input(subDir, head), { env: env(tmp()), fetchImpl: server.fetchImpl, ...fast }))

        const submit = server.calls.find((c) => c.url.endsWith("/api/runs"))!
        const diff = (submit.body as { source: { diff: string } }).source.diff
        expect(diff).toContain("+++ b/outside.ts")
        expect(diff).toContain("+++ b/sub/x.ts")
        expect(diff).not.toContain("img.bin")
    })

    /** The additionalContext of the single JSON line the hook printed. */
    const noticeOf = (out: string) => JSON.parse(out.trim()).hookSpecificOutput?.additionalContext as string | undefined
    const shownBy = (out: string) => JSON.parse(out.trim()).systemMessage as string
    /** A user-facing message names no run id, HTTP status or code, URL, run status, server error or git command. */
    const INTERNALS = /run_\w+|HTTP|https?:\/\/|status "|git \w+|NOT_FOUND|INTERNAL|fetch failed|did not apply/
    const plain = (text: string | undefined): string => {
        expect(text).toBeDefined()
        expect(text).not.toMatch(INTERNALS)
        return text!
    }

    test("an unconfigured plugin is reported by the synchronous hook on every commit; the background hook stays quiet and never calls the API", async () => {
        const repo = fixtureRepo()
        const server = fakeServer()
        const bare = { CLAUDE_PLUGIN_DATA: tmp() }
        for (const name of ["c", "c2"]) {
            const head = repo.commit({ [`${name}.ts`]: "x\n" }, name)
            const start = await capture(() => announceCommitCheck(input(repo.work, head), { env: bare }))
            const shown = plain(shownBy(start.out))
            expect(shown).toContain(`commit ${head.slice(0, 7)} was not checked. The plugin is not configured`)
            expect(shown).toContain("AMPLIFY_API_KEY")
            expect(JSON.parse(start.out.trim()).hookSpecificOutput.additionalContext).toContain("Mention this to the user")
            const check = await capture(() => runCommitCheck(input(repo.work, head), { env: bare, fetchImpl: server.fetchImpl, ...fast }))
            expect(check).toEqual({ result: 0, out: "" })
        }
        expect(server.calls).toHaveLength(0)
    })

    test("skips repos that are not Amplify projects, already-checked commits, and failed commits", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "d.ts": "x\n" }, "d")
        const dataDir = tmp()

        // A repository that is not an Amplify project is not announced and gets no notice:
        // the plugin has nothing for it. The log says so, and the answer is remembered
        // for the session so later commits make no lookup at all.
        const notProject = fakeServer({ project: null })
        expect(await capture(() => announceCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: notProject.fetchImpl }))).toEqual({ result: 0, out: "" })
        expect(await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: notProject.fetchImpl, ...fast }))).toEqual({ result: 0, out: "" })
        expect(notProject.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(false)
        expect(readFileSync(join(dataDir, "log.txt"), "utf8")).toContain("is not an Amplify project")
        const lookups = notProject.calls.length
        expect(await capture(() => announceCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: notProject.fetchImpl }))).toEqual({ result: 0, out: "" })
        expect(await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: notProject.fetchImpl, ...fast }))).toEqual({ result: 0, out: "" })
        expect(notProject.calls).toHaveLength(lookups)

        const server = fakeServer()
        const failed: HookInput = { ...input(repo.work, head, "s2"), tool_response: { stdout: "", stderr: "nothing to commit" } }
        run(repo.work, ["git", "reset", "-q", "--soft", "HEAD"]) // make the reflog's last entry a reset, not a commit
        const b = await capture(() => runCommitCheck(failed, { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(b.result).toBe(0)
        expect(server.calls).toHaveLength(0)

        const c = await capture(() => runCommitCheck(input(repo.work, head, "s2"), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(c.result).toBe(2) // clean run, marks checked
        expect(JSON.parse(c.out.trim()).rewakeSummary).toContain("no findings")
        const d = await capture(() => runCommitCheck(input(repo.work, head, "s2"), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(d.out).toBe("")
        expect(server.calls.filter((x) => x.url.endsWith("/api/runs"))).toHaveLength(1)
    })

    test("a failed run is reported through the rewake channel without findings, and the server's error text reaches neither the notice nor the log", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "e.ts": "x\n" }, "e")
        const server = fakeServer({ statuses: ["error"] })
        const dataDir = tmp()
        const { result, out } = await capture(() =>
            runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast })
        )
        expect(result).toBe(2)
        expect(plain(noticeOf(out))).toContain(`the check for commit ${head.slice(0, 7)} failed. The run did not complete on Amplify's side`)
        const log = readFileSync(join(dataDir, "log.txt"), "utf8")
        expect(log).toContain('run run_1 ended with status "error"')
        expect(log).not.toContain("did not apply")
    })

    test("a mid-poll failure (not a terminal run status) is reported through the rewake channel, not swallowed", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "g.ts": "x\n" }, "g")
        const base = fakeServer()
        let pollCalls = 0
        const fetchImpl: FakeServer["fetchImpl"] = async (url, init) => {
            if (new URL(url).pathname.startsWith("/api/runs/")) {
                pollCalls++
                throw new TypeError("fetch failed")
            }
            return base.fetchImpl(url, init)
        }
        const { result, out } = await capture(() => runCommitCheck(input(repo.work, head), { env: env(tmp()), fetchImpl, ...fast }))
        expect(result).toBe(2)
        expect(pollCalls).toBeGreaterThanOrEqual(5) // waitForRun gives up after 5 consecutive poll failures
        expect(plain(noticeOf(out))).toContain("Amplify stopped answering while the run was in progress. Amplify could not be reached")
    })

    test("a run that never finishes is reported as failed once the wait deadline passes", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "slow.ts": "x\n" }, "slow")
        const base = fakeServer({ statuses: ["running"] })
        const clock = { t: 1_000_000_000 }
        const fetchImpl: FakeServer["fetchImpl"] = async (url, init) => {
            if (new URL(url).pathname.startsWith("/api/runs/")) clock.t += 10 * 60 * 1000
            return base.fetchImpl(url, init)
        }
        const { result, out } = await capture(() =>
            runCommitCheck(input(repo.work, head), { env: env(tmp()), fetchImpl, now: () => clock.t, sleep: async () => {} })
        )
        expect(result).toBe(2)
        expect(plain(noticeOf(out))).toContain("did not finish within 25 minutes")
    })

    test("an unexpected error after the check was announced is reported as a failed check, not swallowed", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "boom.ts": "x\n" }, "boom")
        const dataDir = tmp()
        writeFileSync(join(dataDir, "dry-run"), "a file where the dry-run directory should be")
        const { result, out } = await capture(() => runCommitCheck(input(repo.work, head), { env: { CLAUDE_PLUGIN_DATA: dataDir, AMPLIFY_DRY_RUN: "1" }, ...fast }))
        expect(result).toBe(2)
        expect(plain(noticeOf(out))).toContain(`the check for commit ${head.slice(0, 7)} failed. The plugin hit an unexpected error`)
        expect(readFileSync(join(dataDir, "log.txt"), "utf8")).toContain("unhandled error")
    })

    test("a commit with nothing Amplify can check is reported as such, and counts as reviewed", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "img.bin": "\0\0\0" }, "binary only")
        const dataDir = tmp()
        const start = await capture(() => announceCommitCheck(input(repo.work, head), { env: env(dataDir) }))
        expect(plain(shownBy(start.out))).toContain(`commit ${head.slice(0, 7)} has no changes Amplify can check`)
        // The synchronous hook records the skip, so the background hook stays quiet in either order.
        expect(readCheckedShas(join(repo.work, ".git")).completed.has(head)).toBe(true)
        const server = fakeServer()
        expect(await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))).toEqual({ result: 0, out: "" })
        expect(server.calls).toHaveLength(0)
    })

    test("a skipped commit is recorded by the synchronous hook only, so the background hook can never make it fall silent", async () => {
        const repo = fixtureRepo()
        const many = Object.fromEntries(Array.from({ length: MAX_DIFF_FILES + 1 }, (_, i) => [`gen/f${i}.ts`, `${i}\n`]))
        const head = repo.commit(many, "huge")
        const dataDir = tmp()
        // Background hook first: it must not record the commit...
        expect(await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: fakeServer().fetchImpl, ...fast }))).toEqual({ result: 0, out: "" })
        expect(readCheckedShas(join(repo.work, ".git")).all.has(head)).toBe(false)
        // ...so the synchronous hook still reports it, and it is the one that records it.
        const start = await capture(() => announceCommitCheck(input(repo.work, head), { env: env(dataDir) }))
        expect(plain(shownBy(start.out))).toContain(`commit ${head.slice(0, 7)} was not checked`)
        expect(readCheckedShas(join(repo.work, ".git")).all.has(head)).toBe(true)
    })

    test("ignores non-commit commands, including plumbing subcommands like commit-tree", async () => {
        const repo = fixtureRepo()
        const server = fakeServer()
        const notCommit: HookInput = { ...input(repo.work, repo.first), tool_input: { command: "git status" } }
        expect(await runCommitCheck(notCommit, { env: env(tmp()), fetchImpl: server.fetchImpl, ...fast })).toBe(0)
        const commitTree: HookInput = { ...input(repo.work, repo.first), tool_input: { command: "git commit-tree HEAD^{tree} -m x" } }
        expect(await runCommitCheck(commitTree, { env: env(tmp()), fetchImpl: server.fetchImpl, ...fast })).toBe(0)
        expect(server.calls).toHaveLength(0)
    })

    test("recognizes a commit chained with another command without a space", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "src/a.ts": "line1\n" }, "a")
        const server = fakeServer()
        const semicolon: HookInput = { ...input(repo.work, head), tool_input: { command: "git commit;echo done" } }
        expect(await capture(() => runCommitCheck(semicolon, { env: env(tmp()), fetchImpl: server.fetchImpl, ...fast }))).toMatchObject({ result: 2 })
        expect(server.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(true)

        const repo2 = fixtureRepo()
        const head2 = repo2.commit({ "src/a.ts": "line1\n" }, "a")
        const server2 = fakeServer()
        const andand: HookInput = { ...input(repo2.work, head2), tool_input: { command: "git commit&&echo done" } }
        expect(await capture(() => runCommitCheck(andand, { env: env(tmp()), fetchImpl: server2.fetchImpl, ...fast }))).toMatchObject({ result: 2 })
        expect(server2.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(true)
    })

    test("dry run writes the diff and request to disk, makes no API calls (not even to resolve the org), and leaves the commit unchecked", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "src/a.ts": "line1\n" }, "a")
        const server = fakeServer()
        const dataDir = tmp()
        // Configured with a key but no org_id: a real run would list memberships first.
        const { result, out } = await capture(() =>
            runCommitCheck(input(repo.work, head), { env: { CLAUDE_PLUGIN_DATA: dataDir, AMPLIFY_DRY_RUN: "1", AMPLIFY_API_KEY: "key" }, fetchImpl: server.fetchImpl, ...fast })
        )
        expect(result).toBe(0)
        expect(out).toBe("")
        expect(server.calls).toHaveLength(0)
        const patch = join(dataDir, "dry-run", `${head.slice(0, 12)}.patch`)
        expect(readFileSync(join(dataDir, "log.txt"), "utf8")).toContain(`dry run: wrote ${patch}`)
        expect(readFileSync(patch, "utf8")).toContain("+++ b/src/a.ts")
        const record = JSON.parse(readFileSync(join(dataDir, "dry-run", `${head.slice(0, 12)}.json`), "utf8"))
        expect(record).toMatchObject({
            commitSha: head,
            baseSha: repo.first,
            projectId: null,
            files: ["src/a.ts"],
            scope: { "src/a.ts": [1] },
            request: { path: "/api/runs", body: { agentName: "detections-runner" } },
        })
        expect(readCheckedShas(join(repo.work, ".git")).all.has(head)).toBe(false)
        expect(existsSync(patch)).toBe(true)
    })

    test("dry run tolerates a repo with no remote and nothing pushed, diffing a root commit against the empty tree", async () => {
        const lonely = tmp()
        run(lonely, ["git", "init", "-q", "-b", "main"])
        run(lonely, ["git", "config", "user.email", "t@e"])
        run(lonely, ["git", "config", "user.name", "t"])
        await Bun.write(join(lonely, "hello.py"), "print('hi')\n")
        run(lonely, ["git", "add", "-A"])
        run(lonely, ["git", "commit", "-q", "-m", "root"])
        const head = run(lonely, ["git", "rev-parse", "HEAD"])
        const server = fakeServer()
        const dataDir = tmp()

        const { result } = await capture(() =>
            runCommitCheck(input(lonely, head), { env: { CLAUDE_PLUGIN_DATA: dataDir, AMPLIFY_DRY_RUN: "1" }, fetchImpl: server.fetchImpl, ...fast })
        )
        expect(result).toBe(0)
        expect(server.calls).toHaveLength(0)
        expect(readFileSync(join(dataDir, "dry-run", `${head.slice(0, 12)}.patch`), "utf8")).toContain("+print('hi')")
        const record = JSON.parse(readFileSync(join(dataDir, "dry-run", `${head.slice(0, 12)}.json`), "utf8"))
        expect(record.repoUrl).toBeNull()
        expect(record.baseFallback).toContain("empty tree")
        expect(record.scope).toEqual({ "hello.py": [1] })
    })

    test("without org_id, a key with one organization uses it, sends the header, and caches it", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "o.ts": "x\n" }, "o")
        const dataDir = tmp()
        const server = fakeServer({ orgs: ["org_solo"] })
        const noOrgEnv = { CLAUDE_PLUGIN_DATA: dataDir, AMPLIFY_API_KEY: "key", AMPLIFY_API_URL: "https://api.test" }
        const { result } = await capture(() => runCommitCheck(input(repo.work, head), { env: noOrgEnv, fetchImpl: server.fetchImpl, ...fast }))
        expect(result).toBe(2) // clean
        expect(server.calls[0]!.url).toContain("/v1.1/user/memberships")
        const submit = server.calls.find((c) => c.url.endsWith("/api/runs"))!
        expect((submit as unknown as { url: string }).url).toBeDefined()
        expect(readFileSync(join(dataDir, "org.json"), "utf8")).toContain("org_solo")

        // Second commit: the cached org is used and memberships are not fetched again.
        const head2 = repo.commit({ "o2.ts": "y\n" }, "o2")
        const server2 = fakeServer({ orgs: ["org_solo"] })
        await capture(() => runCommitCheck(input(repo.work, head2), { env: noOrgEnv, fetchImpl: server2.fetchImpl, ...fast }))
        expect(server2.calls.some((c) => c.url.includes("/v1.1/user/memberships"))).toBe(false)
        expect(server2.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(true)
    })

    test("without org_id, a key with several organizations lists them and asks the user to choose", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "m.ts": "x\n" }, "m")
        const server = fakeServer({ orgs: ["org_a", "org_b"] })
        const noOrg = { CLAUDE_PLUGIN_DATA: tmp(), AMPLIFY_API_KEY: "key", AMPLIFY_API_URL: "https://api.test" }
        // The synchronous hook finds out and tells the user; the background hook stays quiet.
        const first = await capture(() => announceCommitCheck(input(repo.work, head), { env: noOrg, fetchImpl: server.fetchImpl }))
        const notice = plain(shownBy(first.out))
        expect(notice).toContain("2 organizations")
        expect(notice).toContain("ORG_A: org_a")
        expect(notice).toContain("ORG_B: org_b")
        expect(notice).toContain("/plugin configure")
        expect(await capture(() => runCommitCheck(input(repo.work, head), { env: noOrg, fetchImpl: server.fetchImpl, ...fast }))).toEqual({ result: 0, out: "" })
        expect(server.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(false)

        // From the next commit on, the reason is repeated in short form, offline.
        const next = repo.commit({ "m2.ts": "y\n" }, "m2")
        const calls = server.calls.length
        const start = await capture(() => announceCommitCheck(input(repo.work, next), { env: noOrg }))
        expect(plain(shownBy(start.out))).toContain(`commit ${next.slice(0, 7)} was not checked. Your API key belongs to 2 organizations`)
        expect(await capture(() => runCommitCheck(input(repo.work, next), { env: noOrg, fetchImpl: server.fetchImpl, ...fast }))).toEqual({ result: 0, out: "" })
        expect(server.calls).toHaveLength(calls)
    })

    test("a commit that adds no lines re-surfaces nothing from earlier unpushed commits", async () => {
        const repo = fixtureRepo()
        const first = repo.commit({ "src/a.ts": "line1\n" }, "add a")
        const dataDir = tmp()
        // The server keeps reporting the finding from the first commit for every base..HEAD run.
        const server = fakeServer({ findings: [finding("src/a.ts", 1)] })
        const a = await capture(() => runCommitCheck(input(repo.work, first), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(a.result).toBe(2)

        run(repo.work, ["git", "rm", "-q", "README.md"])
        run(repo.work, ["git", "commit", "-q", "-m", "delete only"])
        const second = run(repo.work, ["git", "rev-parse", "HEAD"])
        const b = await capture(() => runCommitCheck(input(repo.work, second), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(b.result).toBe(2)
        expect(JSON.parse(b.out.trim()).rewakeSummary).toBe(`Amplify Console: no findings in commit ${second.slice(0, 7)}`)
    })

    test("an unknown cadence is reported like any other misconfiguration", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "cad.ts": "x\n" }, "cad")
        const server = fakeServer()
        const bad = env(tmp(), { AMPLIFY_CADENCE: "push" })
        const start = await capture(() => announceCommitCheck(input(repo.work, head), { env: bad }))
        expect(plain(shownBy(start.out))).toContain('was not checked. The plugin\'s cadence is set to "push"')
        expect(await capture(() => runCommitCheck(input(repo.work, head), { env: bad, fetchImpl: server.fetchImpl, ...fast }))).toEqual({ result: 0, out: "" })
        expect(server.calls).toHaveLength(0)
    })

    test("a failed submission is reported for every commit it happens to, not once per session", async () => {
        const repo = fixtureRepo()
        const dataDir = tmp()
        const base = fakeServer()
        const fetchImpl: FakeServer["fetchImpl"] = async (url, init) => {
            if (new URL(url).pathname === "/api/runs") return new Response(JSON.stringify({ error: "INTERNAL", message: "Snapshot console/sandbox-dev:feature is unavailable" }), { status: 500 })
            return base.fetchImpl(url, init)
        }
        const first = repo.commit({ "p.ts": "x\n" }, "p")
        const a = await capture(() => runCommitCheck(input(repo.work, first), { env: env(dataDir), fetchImpl, ...fast }))
        const second = repo.commit({ "q.ts": "y\n" }, "q")
        const b = await capture(() => runCommitCheck(input(repo.work, second), { env: env(dataDir), fetchImpl, ...fast }))
        expect(a.result).toBe(2)
        expect(plain(noticeOf(a.out))).toContain(`the check for commit ${first.slice(0, 7)} failed. The detections run could not be started. Amplify returned a server error`)
        // The log keeps the status and error code for correlation, not the server's message body.
        const log = readFileSync(join(dataDir, "log.txt"), "utf8")
        expect(log).toContain("failed: HTTP 500 INTERNAL")
        expect(log).not.toContain("snapshot is unavailable")
        expect(b.result).toBe(2)
        expect(plain(noticeOf(b.out))).toContain(`the check for commit ${second.slice(0, 7)} failed. The detections run could not be started`)
    })

    test("without the `[branch sha]` line, only a commit made moments ago counts; an older one is not Claude's", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "u.ts": "x\n" }, "user commit")
        const quiet: HookInput = { ...input(repo.work, head), tool_input: { command: "git commit -q -m x" }, tool_response: { stdout: "" } }

        // The same reflog entry, seen ten minutes later: a failed `git commit` wrote nothing newer.
        const stale = fakeServer()
        const later = () => Date.now() + 10 * 60 * 1000
        const a = await capture(() => runCommitCheck(quiet, { env: env(tmp()), fetchImpl: stale.fetchImpl, ...fast, now: later }))
        expect(a.result).toBe(0)
        expect(a.out).toBe("")
        expect(stale.calls).toHaveLength(0)
        expect(readCheckedShas(join(repo.work, ".git")).all.has(head)).toBe(false)

        const fresh = fakeServer()
        const b = await capture(() => runCommitCheck(quiet, { env: env(tmp()), fetchImpl: fresh.fetchImpl, ...fast }))
        expect(b.result).toBe(2) // clean
        expect(fresh.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(true)
    })

    test("the cached project id is only reused for the organization it was looked up in", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "k.ts": "x\n" }, "k")
        const dataDir = tmp()
        const one = fakeServer()
        await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: one.fetchImpl, ...fast }))
        expect(one.calls.filter((c) => c.url.includes("/api/projects"))).toHaveLength(1)
        expect(JSON.parse(readFileSync(join(repo.work, ".git", "amplify-console.json"), "utf8"))).toMatchObject({ orgId: "org_1", projectId: "p1" })

        const head2 = repo.commit({ "k2.ts": "y\n" }, "k2")
        const two = fakeServer({ project: "p2" })
        await capture(() => runCommitCheck(input(repo.work, head2), { env: env(dataDir, { AMPLIFY_ORG_ID: "org_2" }), fetchImpl: two.fetchImpl, ...fast }))
        expect(two.calls.filter((c) => c.url.includes("/api/projects"))).toHaveLength(1)
        expect(two.calls.find((c) => c.url.endsWith("/api/runs"))!.body).toMatchObject({ projectId: "p2" })
    })

    test("a commit whose run failed stays in scope for the next commit", async () => {
        const repo = fixtureRepo()
        const dataDir = tmp()
        const k1 = repo.commit({ "k1.ts": "bad\n" }, "k1")
        const failing = fakeServer({ statuses: ["error"] })
        const a = await capture(() => runCommitCheck(input(repo.work, k1), { env: env(dataDir), fetchImpl: failing.fetchImpl, ...fast }))
        expect(a.result).toBe(2)
        expect(plain(noticeOf(a.out))).toContain("did not complete on Amplify's side")
        const afterFailure = readCheckedShas(join(repo.work, ".git"))
        expect(afterFailure.all.has(k1)).toBe(true) // not resubmitted...
        expect(afterFailure.completed.has(k1)).toBe(false) // ...but not reviewed either

        // The next commit's run covers base..k2, and k1's finding is still in scope.
        const k2 = repo.commit({ "k2.ts": "fine\n" }, "k2")
        const ok = fakeServer({ findings: [finding("k1.ts", 1)] })
        const b = await capture(() => runCommitCheck(input(repo.work, k2), { env: env(dataDir), fetchImpl: ok.fetchImpl, ...fast }))
        expect(b.result).toBe(2)
        expect(JSON.parse(b.out.trim()).hookSpecificOutput.additionalContext).toContain("k1.ts:1")
        expect(readCheckedShas(join(repo.work, ".git")).completed.has(k2)).toBe(true)
    })

    test("scope never reaches past the pushed base, so the user's own pushed lines are not attributed to Claude", async () => {
        const repo = fixtureRepo()
        const dataDir = tmp()
        const c1 = repo.commit({ "c1.ts": "x\n" }, "c1")
        await capture(() => runCommitCheck(input(repo.work, c1), { env: env(dataDir), fetchImpl: fakeServer().fetchImpl, ...fast }))
        // The user commits by hand and pushes both; c1 is now a completed check older than the base.
        repo.commit({ "user.ts": "y\n" }, "user")
        repo.push()
        const c3 = repo.commit({ "c3.ts": "z\n" }, "c3")
        const server = fakeServer({ findings: [finding("user.ts", 1), finding("c3.ts", 1)] })
        const { result, out } = await capture(() => runCommitCheck(input(repo.work, c3), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(result).toBe(2)
        const context = JSON.parse(out.trim()).hookSpecificOutput.additionalContext
        expect(context).toContain("c3.ts:1")
        expect(context).not.toContain("user.ts")
    })

    test("`git -C <dir> commit` is checked against <dir>, even when the hook's cwd is another repository", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "c.ts": "x\n" }, "c")
        const workspace = tmp()
        run(workspace, ["git", "init", "-q"])
        const server = fakeServer()
        const hook: HookInput = { ...input(workspace, head), tool_input: { command: `git -C "${repo.work}" commit -m c` } }
        const { result } = await capture(() => runCommitCheck(hook, { env: env(tmp()), fetchImpl: server.fetchImpl, ...fast }))
        expect(result).toBe(2) // clean
        expect(server.calls.find((c) => c.url.endsWith("/api/runs"))!.body).toMatchObject({ source: { baseSha: repo.first } })
        expect(readCheckedShas(join(repo.work, ".git")).all.has(head)).toBe(true)
        expect(existsSync(join(workspace, ".git", "amplify-checked-shas"))).toBe(false)
    })

    test("`cd <repo> && git commit` is checked against <repo>, not the hook's cwd", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "d.ts": "x\n" }, "d")
        const workspace = tmp()
        run(workspace, ["git", "init", "-q"])
        const server = fakeServer()
        const hook: HookInput = { ...input(workspace, head), tool_input: { command: `cd ${repo.work} && git add -A && git commit -m d` } }
        const { result } = await capture(() => runCommitCheck(hook, { env: env(tmp()), fetchImpl: server.fetchImpl, ...fast }))
        expect(result).toBe(2) // clean
        expect(server.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(true)
        expect(readCheckedShas(join(repo.work, ".git")).all.has(head)).toBe(true)
    })

    test("with a PreToolUse snapshot, a quiet commit is checked even after a slow trailing step", async () => {
        const repo = fixtureRepo()
        const dataDir = tmp()
        const command = "git commit -q -m s && bun test"
        const quiet = (head: string): HookInput => ({ ...input(repo.work, head), tool_input: { command }, tool_response: { stdout: "" } })

        // PreToolUse: HEAD is still the first commit.
        expect(await recordPreCommitHead(quiet(repo.first), { env: env(dataDir) })).toBe(0)
        expect(readPreCommitHead(dataDir, "s1", (await gitDir(repo.work))!)).toEqual({ head: repo.first, command })
        const head = repo.commit({ "s.ts": "x\n" }, "s")
        // PostToolUse, ten minutes later (the trailing step was slow): HEAD moved during this call, so it counts.
        const server = fakeServer()
        const { result } = await capture(() => runCommitCheck(quiet(head), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast, now: () => Date.now() + 10 * 60 * 1000 }))
        expect(result).toBe(2) // clean
        expect(server.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(true)
    })

    test("with a PreToolUse snapshot, a commit the user made just before Claude's failed one is not claimed", async () => {
        const repo = fixtureRepo()
        const dataDir = tmp()
        const head = repo.commit({ "u.ts": "x\n" }, "user commit") // seconds ago, by the user
        const command = "git commit -m x"
        const failed: HookInput = { ...input(repo.work, head), tool_input: { command }, tool_response: { stdout: "nothing to commit, working tree clean" } }
        await recordPreCommitHead(failed, { env: env(dataDir) }) // HEAD is already the user's commit
        const server = fakeServer()
        const { result, out } = await capture(() => runCommitCheck(failed, { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(result).toBe(0)
        expect(out).toBe("")
        expect(server.calls).toHaveLength(0)
        expect(readCheckedShas(join(repo.work, ".git")).all.has(head)).toBe(false)
    })

    test("the size limits cover the whole unpushed range; the synchronous hook reports every commit in it and the background hook stays quiet", async () => {
        const repo = fixtureRepo()
        const dataDir = tmp()
        const many = Object.fromEntries(Array.from({ length: MAX_DIFF_FILES + 1 }, (_, i) => [`gen/f${i}.ts`, `${i}\n`]))
        const server = fakeServer()
        // The first commit is over the limit; a small follow-up commit still is, since the range is the same.
        for (const [files, extra] of [[MAX_DIFF_FILES + 1, many], [MAX_DIFF_FILES + 2, { "small.ts": "x\n" }]] as const) {
            const head = repo.commit(extra, `${files} files`)
            const start = await capture(() => announceCommitCheck(input(repo.work, head), { env: env(dataDir) }))
            expect(plain(shownBy(start.out))).toContain(`commit ${head.slice(0, 7)} was not checked. The unpushed changes now span ${files} files`)
            expect(await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))).toEqual({ result: 0, out: "" })
            const checked = readCheckedShas(join(repo.work, ".git"))
            expect(checked.all.has(head)).toBe(true)
            expect(checked.completed.has(head)).toBe(false)
        }
        expect(server.calls).toHaveLength(0)
    })

    test("a repository that is not onboarded is remembered per repository, so a second repository still gets its own lookup", async () => {
        const dataDir = tmp()
        const a = fixtureRepo()
        const headA = a.commit({ "a.ts": "x\n" }, "a")
        const b = fixtureRepo()
        run(b.work, ["git", "remote", "set-url", "origin", "https://github.com/acme/other.git"])
        const headB = b.commit({ "b.ts": "x\n" }, "b")
        const server = fakeServer({ project: null })
        expect(await capture(() => announceCommitCheck(input(a.work, headA), { env: env(dataDir), fetchImpl: server.fetchImpl }))).toEqual({ result: 0, out: "" })
        expect(await capture(() => announceCommitCheck(input(b.work, headB), { env: env(dataDir), fetchImpl: server.fetchImpl }))).toEqual({ result: 0, out: "" })
        const lookups = server.calls.filter((c) => c.url.includes("/api/projects")).map((c) => decodeURIComponent(c.url))
        expect(lookups).toHaveLength(2)
        expect(lookups[0]).toContain("acme/app.git")
        expect(lookups[1]).toContain("acme/other.git")
    })

    test("the synchronous hook announces only once the repository is known to be a project, and its lookup is reused by the background hook", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "known.ts": "x\n" }, "known")
        const dataDir = tmp()
        const server = fakeServer()
        const start = await capture(() => announceCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: server.fetchImpl }))
        expect(shownBy(start.out)).toContain(`checking commit ${head.slice(0, 7)}`)
        const check = await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(check.result).toBe(2)
        expect(server.calls.filter((c) => c.url.includes("/api/projects"))).toHaveLength(1)
    })

    test("when the synchronous hook cannot tell whether a check will run, it announces nothing and the background hook reports the failure", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "unknown.ts": "x\n" }, "unknown")
        const dataDir = tmp()
        const base = fakeServer()
        const fetchImpl: FakeServer["fetchImpl"] = async (url, init) => {
            if (new URL(url).pathname === "/api/projects") throw new TypeError("fetch failed")
            return base.fetchImpl(url, init)
        }
        expect(await capture(() => announceCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl }))).toEqual({ result: 0, out: "" })
        const { result, out } = await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl, ...fast }))
        expect(result).toBe(2)
        expect(plain(noticeOf(out))).toContain(`the check for commit ${head.slice(0, 7)} failed. This repository could not be looked up in Amplify. Amplify could not be reached`)
    })

    test("the synchronous commit-start hook announces a check, or says why this commit gets none", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "s.ts": "x\n" }, "s")
        const dataDir = tmp()

        const eligible = await capture(() => announceCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: fakeServer().fetchImpl }))
        expect(eligible.result).toBe(0)
        const announced = JSON.parse(eligible.out.trim())
        expect(announced.systemMessage).toContain(`checking commit ${head.slice(0, 7)}`)
        expect(announced.systemMessage).toContain("the result will arrive in this session")
        expect(announced.hookSpecificOutput.additionalContext).toContain("Mention this to the user")

        const dry = await capture(() => announceCommitCheck(input(repo.work, head), { env: { CLAUDE_PLUGIN_DATA: dataDir, AMPLIFY_DRY_RUN: "1" } }))
        expect(JSON.parse(dry.out.trim()).systemMessage).toContain("dry run")

        // Quiet for non-commit commands, for a failed commit, and once the commit has been checked.
        const notCommit = await capture(() => announceCommitCheck({ ...input(repo.work, head), tool_input: { command: "git status" } }, { env: env(dataDir) }))
        expect(notCommit.out).toBe("")
        run(repo.work, ["git", "reset", "-q", "--soft", "HEAD"])
        const failed = await capture(() => announceCommitCheck({ ...input(repo.work, head), tool_response: { stdout: "nothing to commit" } }, { env: env(dataDir) }))
        expect(failed.out).toBe("")
        await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: fakeServer().fetchImpl, ...fast }))
        const checked = await capture(() => announceCommitCheck(input(repo.work, head), { env: env(dataDir) }))
        expect(checked.out).toBe("")

        // A remote the real check rejects (not a hosted URL) means Amplify has nothing for this
        // repository: neither hook says anything, and the log records why.
        const local = fixtureRepo()
        const localHead = local.commit({ "l.ts": "x\n" }, "l")
        run(local.work, ["git", "remote", "set-url", "origin", "/srv/git/app.git"])
        expect(await capture(() => announceCommitCheck(input(local.work, localHead), { env: env(dataDir) }))).toEqual({ result: 0, out: "" })
        expect(await capture(() => runCommitCheck(input(local.work, localHead), { env: env(dataDir), fetchImpl: fakeServer().fetchImpl, ...fast }))).toEqual({ result: 0, out: "" })
        expect(readFileSync(join(dataDir, "log.txt"), "utf8")).toContain("no hosted origin remote")

        // A repository nothing has been pushed from yet is reported: a push fixes it.
        const fresh = tmp("fresh-")
        run(fresh, ["git", "init", "-q", "-b", "main"])
        run(fresh, ["git", "config", "user.email", "t@example.com"])
        run(fresh, ["git", "config", "user.name", "Test"])
        run(fresh, ["git", "remote", "add", "origin", "https://github.com/acme/fresh.git"])
        writeFileSync(join(fresh, "f.ts"), "x\n")
        run(fresh, ["git", "add", "-A"])
        run(fresh, ["git", "commit", "-q", "-m", "f"])
        const freshHead = run(fresh, ["git", "rev-parse", "HEAD"])
        const unpushed = await capture(() => announceCommitCheck(input(fresh, freshHead), { env: env(dataDir) }))
        expect(plain(shownBy(unpushed.out))).toContain(`commit ${freshHead.slice(0, 7)} was not checked. Nothing in this repository has been pushed yet`)
    })
})
