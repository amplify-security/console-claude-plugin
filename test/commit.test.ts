import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { announceCommitCheck, commitDirs, MAX_DIFF_FILES, runCommitCheck } from "../src/commit.ts"
import type { HookInput } from "../src/hook-io.ts"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { readCheckedShas } from "../src/state.ts"
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

describe("commitDirs", () => {
    test("recognizes a commit after -C/-c options, quoted or not, and returns the -C directories", () => {
        expect(commitDirs("git commit -m x")).toEqual([])
        expect(commitDirs('git -C "/Users/me/My Repo" commit -m x')).toEqual(["/Users/me/My Repo"])
        expect(commitDirs("git -c user.name='Foo Bar' -C sub commit")).toEqual(["sub"])
        expect(commitDirs('git -c user.name="Foo Bar" commit -m x')).toEqual([])
        expect(commitDirs("git -C a -C b commit")).toEqual(["a", "b"])
        expect(commitDirs("git status")).toBeNull()
        expect(commitDirs("git commit-tree HEAD^{tree} -m x")).toBeNull()
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

    test("uses the parent as base after `git commit && git push`, and a clean commit is silent", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "b.ts": "x\n" }, "b")
        repo.push()
        const server = fakeServer()
        const { result, out } = await capture(() =>
            runCommitCheck(input(repo.work, head), { env: env(tmp()), fetchImpl: server.fetchImpl, ...fast })
        )
        expect(result).toBe(0)
        expect(server.calls.find((c) => c.url.endsWith("/api/runs"))!.body).toMatchObject({ source: { baseSha: repo.first } })
        // Exit-0 output from the asyncRewake hook is never shown, so nothing is emitted.
        expect(out).toBe("")
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

    test("warns once per session when unconfigured, via the rewake channel, and never calls the API", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "c.ts": "x\n" }, "c")
        const server = fakeServer()
        const dataDir = tmp()
        const bare = { CLAUDE_PLUGIN_DATA: dataDir }
        const first = await capture(() => runCommitCheck(input(repo.work, head), { env: bare, fetchImpl: server.fetchImpl, ...fast }))
        const second = await capture(() => runCommitCheck(input(repo.work, head), { env: bare, fetchImpl: server.fetchImpl, ...fast }))
        expect(first.result).toBe(2)
        expect(noticeOf(first.out)).toContain("not configured")
        expect(noticeOf(first.out)).toContain("Relay this to the user")
        expect(second.result).toBe(0)
        expect(second.out).toBe("")
        expect(server.calls).toHaveLength(0)
    })

    test("skips repos that are not Amplify projects, already-checked commits, and failed commits", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "d.ts": "x\n" }, "d")
        const dataDir = tmp()

        const notProject = fakeServer({ project: null })
        const a = await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: notProject.fetchImpl, ...fast }))
        expect(a.result).toBe(2)
        expect(noticeOf(a.out)).toContain("not onboarded")
        expect(notProject.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(false)

        const server = fakeServer()
        const failed: HookInput = { ...input(repo.work, head), tool_response: { stdout: "", stderr: "nothing to commit" } }
        run(repo.work, ["git", "reset", "-q", "--soft", "HEAD"]) // make the reflog's last entry a reset, not a commit
        const b = await capture(() => runCommitCheck(failed, { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(b.result).toBe(0)
        expect(server.calls).toHaveLength(0)

        const c = await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(c.result).toBe(0) // clean run, marks checked
        const d = await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(d.out).toBe("")
        expect(server.calls.filter((x) => x.url.endsWith("/api/runs"))).toHaveLength(1)
    })

    test("a failed run is reported once through the rewake channel, without findings", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "e.ts": "x\n" }, "e")
        const server = fakeServer({ statuses: ["error"] })
        const { result, out } = await capture(() =>
            runCommitCheck(input(repo.work, head), { env: env(tmp()), fetchImpl: server.fetchImpl, ...fast })
        )
        expect(result).toBe(2)
        expect(noticeOf(out)).toContain('status "error" (diff did not apply cleanly)')
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
        expect(noticeOf(out)).toContain("lost track of run")
        expect(noticeOf(out)).toContain("fetch failed")
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
        expect(await runCommitCheck(semicolon, { env: env(tmp()), fetchImpl: server.fetchImpl, ...fast })).toBe(0)
        expect(server.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(true)

        const repo2 = fixtureRepo()
        const head2 = repo2.commit({ "src/a.ts": "line1\n" }, "a")
        const server2 = fakeServer()
        const andand: HookInput = { ...input(repo2.work, head2), tool_input: { command: "git commit&&echo done" } }
        expect(await runCommitCheck(andand, { env: env(tmp()), fetchImpl: server2.fetchImpl, ...fast })).toBe(0)
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
        expect(result).toBe(0)
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
        const { result, out } = await capture(() =>
            runCommitCheck(input(repo.work, head), { env: { CLAUDE_PLUGIN_DATA: tmp(), AMPLIFY_API_KEY: "key", AMPLIFY_API_URL: "https://api.test" }, fetchImpl: server.fetchImpl, ...fast })
        )
        expect(result).toBe(2)
        const notice = noticeOf(out)!
        expect(notice).toContain("2 organizations")
        expect(notice).toContain("ORG_A: org_a")
        expect(notice).toContain("ORG_B: org_b")
        expect(notice).toContain("/plugin configure")
        expect(server.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(false)
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
        expect(b.result).toBe(0)
        expect(b.out).toBe("")
    })

    test("an unknown cadence is reported like any other misconfiguration", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "cad.ts": "x\n" }, "cad")
        const server = fakeServer()
        const { result, out } = await capture(() =>
            runCommitCheck(input(repo.work, head), { env: env(tmp(), { AMPLIFY_CADENCE: "push" }), fetchImpl: server.fetchImpl, ...fast })
        )
        expect(result).toBe(2)
        expect(noticeOf(out)).toContain('cadence is set to "push"')
        expect(server.calls).toHaveLength(0)
    })

    test("a failed submission is reported for every commit it happens to, not once per session", async () => {
        const repo = fixtureRepo()
        const dataDir = tmp()
        const base = fakeServer()
        const fetchImpl: FakeServer["fetchImpl"] = async (url, init) => {
            if (new URL(url).pathname === "/api/runs") return new Response(JSON.stringify({ error: "INTERNAL" }), { status: 500 })
            return base.fetchImpl(url, init)
        }
        const first = repo.commit({ "p.ts": "x\n" }, "p")
        const a = await capture(() => runCommitCheck(input(repo.work, first), { env: env(dataDir), fetchImpl, ...fast }))
        const second = repo.commit({ "q.ts": "y\n" }, "q")
        const b = await capture(() => runCommitCheck(input(repo.work, second), { env: env(dataDir), fetchImpl, ...fast }))
        expect(a.result).toBe(2)
        expect(noticeOf(a.out)).toContain(`could not start a detections run for commit ${first.slice(0, 7)}`)
        expect(b.result).toBe(2)
        expect(noticeOf(b.out)).toContain(`could not start a detections run for commit ${second.slice(0, 7)}`)
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
        expect(b.result).toBe(0)
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
        expect(noticeOf(a.out)).toContain('status "error"')
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
        expect(result).toBe(0)
        expect(server.calls.find((c) => c.url.endsWith("/api/runs"))!.body).toMatchObject({ source: { baseSha: repo.first } })
        expect(readCheckedShas(join(repo.work, ".git")).all.has(head)).toBe(true)
        expect(existsSync(join(workspace, ".git", "amplify-checked-shas"))).toBe(false)
    })

    test("the size limits cover the whole unpushed range and are reported once per base", async () => {
        const repo = fixtureRepo()
        const dataDir = tmp()
        const many = Object.fromEntries(Array.from({ length: MAX_DIFF_FILES + 1 }, (_, i) => [`gen/f${i}.ts`, `${i}\n`]))
        const huge = repo.commit(many, "huge")
        const server = fakeServer()
        const a = await capture(() => runCommitCheck(input(repo.work, huge), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(a.result).toBe(2)
        expect(noticeOf(a.out)).toContain(`skipped commit ${huge.slice(0, 7)}: the unpushed changes since ${repo.first.slice(0, 7)} touch ${MAX_DIFF_FILES + 1} files`)
        expect(readCheckedShas(join(repo.work, ".git")).completed.has(huge)).toBe(false)

        // A small follow-up commit is still over the limit (same range) and is not reported again.
        const small = repo.commit({ "small.ts": "x\n" }, "small")
        const b = await capture(() => runCommitCheck(input(repo.work, small), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(b.result).toBe(0)
        expect(b.out).toBe("")
        expect(server.calls.some((c) => c.url.endsWith("/api/runs"))).toBe(false)
    })

    test("a repository-specific notice is given for each repository a session commits in", async () => {
        const dataDir = tmp()
        const a = fixtureRepo()
        const headA = a.commit({ "a.ts": "x\n" }, "a")
        const b = fixtureRepo()
        const headB = b.commit({ "b.ts": "x\n" }, "b")
        const server = fakeServer({ project: null })
        const first = await capture(() => runCommitCheck(input(a.work, headA), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        const second = await capture(() => runCommitCheck(input(b.work, headB), { env: env(dataDir), fetchImpl: server.fetchImpl, ...fast }))
        expect(noticeOf(first.out)).toContain("not onboarded")
        expect(noticeOf(second.out)).toContain("not onboarded")
    })

    test("the synchronous commit-start hook announces a check only when one will run", async () => {
        const repo = fixtureRepo()
        const head = repo.commit({ "s.ts": "x\n" }, "s")
        const dataDir = tmp()

        const eligible = await capture(() => announceCommitCheck(input(repo.work, head), { env: env(dataDir) }))
        expect(eligible.result).toBe(0)
        const announced = JSON.parse(eligible.out.trim())
        expect(announced.systemMessage).toContain(`checking commit ${head.slice(0, 7)}`)
        expect(announced.systemMessage).toContain("a clean result is silent")
        expect(announced.hookSpecificOutput.additionalContext).toContain("Mention this to the user")

        const dry = await capture(() => announceCommitCheck(input(repo.work, head), { env: { CLAUDE_PLUGIN_DATA: dataDir, AMPLIFY_DRY_RUN: "1" } }))
        expect(JSON.parse(dry.out.trim()).systemMessage).toContain("dry run")

        // Quiet when unconfigured (the background hook owns that notice), for non-commit
        // commands, for a failed commit, and once the commit has been checked.
        const unconfigured = await capture(() => announceCommitCheck(input(repo.work, head), { env: { CLAUDE_PLUGIN_DATA: dataDir } }))
        expect(unconfigured.out).toBe("")
        const notCommit = await capture(() => announceCommitCheck({ ...input(repo.work, head), tool_input: { command: "git status" } }, { env: env(dataDir) }))
        expect(notCommit.out).toBe("")
        run(repo.work, ["git", "reset", "-q", "--soft", "HEAD"])
        const failed = await capture(() => announceCommitCheck({ ...input(repo.work, head), tool_response: { stdout: "nothing to commit" } }, { env: env(dataDir) }))
        expect(failed.out).toBe("")
        await capture(() => runCommitCheck(input(repo.work, head), { env: env(dataDir), fetchImpl: fakeServer().fetchImpl, ...fast }))
        const checked = await capture(() => announceCommitCheck(input(repo.work, head), { env: env(dataDir) }))
        expect(checked.out).toBe("")

        // A remote the real check rejects (not a hosted URL) is not announced either.
        const local = fixtureRepo()
        const localHead = local.commit({ "l.ts": "x\n" }, "l")
        run(local.work, ["git", "remote", "set-url", "origin", "/srv/git/app.git"])
        const unsupported = await capture(() => announceCommitCheck(input(local.work, localHead), { env: env(dataDir) }))
        expect(unsupported.out).toBe("")
    })
})
