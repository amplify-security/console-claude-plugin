/**
 * The commit trigger: build the diff for the commit Claude just made, run the
 * org's detections against it in Amplify, and wake Claude with the findings.
 *
 * Every early exit is code 0 ("nothing to report"). Exit 2 wakes Claude, either
 * with in-scope findings or with a notice the user has to act on, after
 * emitting the model-visible context.
 */
import { AGENT_NAME, AmplifyApi, ApiError, TERMINAL_STATUSES, type Run } from "./amplify-api.ts"
import { type Config, isDryRun, loadConfig } from "./config.ts"
import { filterToScope, formatContext, formatSummary, inScope, parseFinding } from "./findings.ts"
import * as git from "./git.ts"
import { EXIT_OK, EXIT_REWAKE, emit, type HookInput, type HookOutput } from "./hook-io.ts"
import { homedir } from "node:os"
import { resolve } from "node:path"
import * as state from "./state.ts"

export const MAX_DIFF_FILES = 300
export const MAX_DIFF_BYTES = 1024 * 1024
/** Total time to wait for a run before giving up; the hook timeout is 1800s. */
export const MAX_WAIT_SECONDS = 25 * 60
export const POLL_WAIT_SECONDS = 30
/**
 * Without a PreToolUse snapshot of HEAD, how recent HEAD's reflog entry must be
 * to count as "this tool call's commit" when the `[branch sha]` output line is
 * absent (quiet or redirected).
 */
export const RECENT_COMMIT_SECONDS = 120

/**
 * Which commands are commits. hooks.json fires on any `git` command
 * (`Bash(git *)`); this is the exact test, per subcommand, and accepts the
 * `-C <dir>` and `-c key=value` options before `commit`. An option value is a
 * run of quoted strings and bare characters, so `-C "My Repo"` and
 * `-c user.name="Foo Bar"` are single values.
 */
const OPTION_VALUE = /(?:"[^"]*"|'[^']*'|[^\s"'])+/
const GIT_COMMIT_RE = new RegExp(`\\bgit((?:\\s+-[cC]\\s+${OPTION_VALUE.source})*)\\s+commit(?![\\w-])`)
const GIT_OPTION_RE = new RegExp(`-([cC])\\s+(${OPTION_VALUE.source})`, "g")
const CD_RE = new RegExp(`^cd(?:\\s+(${OPTION_VALUE.source}))?$`)
/** Shell operators that separate subcommands; `||` must come before `|`. */
const SUBCOMMAND_SEPARATOR = /&&|\|\||;|\||\n/

function unquote(value: string): string {
    return value.replace(/"([^"]*)"|'([^']*)'/g, (_, d: string | undefined, s: string | undefined) => d ?? s ?? "")
}

function resolveDir(from: string, target: string, home: string): string {
    return resolve(from, target === "~" || target.startsWith("~/") ? home + target.slice(1) : target)
}

/**
 * The directory a git commit in `command` runs in: the hook's cwd, moved by
 * any `cd` in an earlier subcommand (`cd app && git commit`) and by the
 * commit's own `-C` options (cumulative, each relative to the previous).
 * Null when no subcommand is a git commit.
 */
export function commitStartDir(command: string, cwd: string, home: string = homedir()): string | null {
    let dir = cwd
    for (const part of command.split(SUBCOMMAND_SEPARATOR)) {
        const sub = part.trim()
        const cd = CD_RE.exec(sub)
        if (cd) {
            dir = cd[1] ? resolveDir(dir, unquote(cd[1]), home) : home
            continue
        }
        const commit = GIT_COMMIT_RE.exec(sub)
        if (!commit) continue
        for (const option of commit[1]!.matchAll(GIT_OPTION_RE)) {
            if (option[1] === "C") dir = resolveDir(dir, unquote(option[2]!), home)
        }
        return dir
    }
    return null
}

export interface CommitCheckDeps {
    env?: Record<string, string | undefined>
    fetchImpl?: ConstructorParameters<typeof AmplifyApi>[1]
    now?: () => number
    /** Sleep is only used between polls when the server returns early. */
    sleep?: (ms: number) => Promise<void>
}

export async function runCommitCheck(input: HookInput, deps: CommitCheckDeps = {}): Promise<number> {
    const env = deps.env ?? process.env
    const dataDir = state.dataDir(env)
    const log = (message: string) => state.log(dataDir, `[${input.session_id}] ${message}`)
    /**
     * A once-per-session notice for the user, for problems with the setup that
     * every commit would hit alike. An asyncRewake hook only surfaces output on
     * exit 2, so notices ride the same channel as findings: Claude is woken with
     * the text and asked to relay it. Returns the exit code to use.
     */
    const notifyOnce = (key: string, message: string): number => {
        log(message)
        if (!state.firstTimeThisSession(dataDir, input.session_id, key)) return EXIT_OK
        emit({ rewakeSummary: "Amplify Console: action needed", additionalContext: formatNotice(message) })
        return EXIT_REWAKE
    }

    const prelude = await commitPrelude(input, env, dataDir, log, deps.now)
    if (prelude.kind === "skip") return EXIT_OK
    if (prelude.kind === "unconfigured") return notifyOnce("unconfigured", prelude.problem)
    const { dryRun, config, cwd, gitDir, head, checked } = prelude
    /** Like notifyOnce, but per commit: a check that was lost is worth hearing about each time. */
    const notifyPerCommit = (key: string, message: string): number => notifyOnce(`${key}-${head.slice(0, 12)}`, message)
    /** Like notifyOnce, but per repository: a session can commit in several, each with its own problem. */
    const notifyPerRepo = (key: string, message: string): number => notifyOnce(`${key}-${state.keyFingerprint(gitDir)}`, message)

    // A dry run tolerates what the real run cannot: no hosted remote and no
    // pushed base. It records the substitutions so the diff can still be reviewed.
    const remote = await git.originUrl(cwd)
    const repoUrl = remote ? git.normalizeRepoUrl(remote) : null
    if (!repoUrl && !dryRun) {
        return notifyPerRepo("no-remote", "Amplify Console: this repository has no hosted origin remote, so detections did not run.")
    }

    // A dry run never touches the network, so it gets no client.
    let api = config && !dryRun ? new AmplifyApi(config, deps.fetchImpl) : null
    let orgId = config?.orgId ?? ""
    if (api && config && !orgId) {
        const resolved = await resolveOrg(api, config, dataDir, log)
        if (!resolved.ok) return notifyOnce("org-unresolved", resolved.message)
        orgId = resolved.orgId
        api = api.withOrg(orgId)
    }
    let projectId: string
    if (dryRun) {
        // No network in a dry run: use the cached project id if there is one.
        const cached = state.readRepoCache(gitDir)
        projectId = cached && cached.repoUrl === repoUrl ? cached.projectId : ""
    } else {
        try {
            projectId = await resolveProjectId(api!, gitDir, repoUrl!, orgId)
        } catch (err) {
            return notifyPerCommit("project-lookup-failed", `Amplify Console: could not reach Amplify to look up this repository (${describe(err)}).`)
        }
    }
    if (!projectId && !dryRun) {
        return notifyPerRepo("not-a-project", `Amplify Console: ${repoUrl} is not onboarded as an Amplify project, so detections did not run.`)
    }

    let base = await resolveBase(cwd, head)
    let baseFallback: string | undefined
    if (!base) {
        if (!dryRun) {
            return notifyPerRepo("no-pushed-base", "Amplify Console: no commit in this repository has been pushed yet, so there is no base to diff against.")
        }
        const parent = (await git.ancestors(cwd, `${head}^`, 1))[0]
        base = parent ?? (await git.emptyTree(cwd))
        if (!base) return EXIT_OK
        baseFallback = parent ? "no pushed base; used the parent commit" : "root commit with no pushed base; used the empty tree"
    }

    // The diff is base..HEAD, i.e. every unpushed commit, so the size limits
    // apply to that whole range: once exceeded, every commit until the next
    // push is skipped. Reported once per base, and the skipped commits stay
    // "attempted" so their lines remain in scope for a later check.
    const short = head.slice(0, 7)
    const since = `the unpushed changes since ${base.slice(0, 7)}`
    const stats = await git.diffStats(cwd, base, head)
    if (!stats) {
        // Unlike an empty diff, a failed one leaves the commit unreviewed: not a scope frontier.
        state.appendCheckedSha(gitDir, head, "attempted")
        return notifyPerCommit("diff-failed", `Amplify Console: could not compute the diff for commit ${short} (git diff failed), so it was not checked.`)
    }
    if (stats.files.length === 0) {
        state.appendCheckedSha(gitDir, head, "completed")
        return EXIT_OK
    }
    if (stats.files.length > MAX_DIFF_FILES) {
        state.appendCheckedSha(gitDir, head, "attempted")
        return notifyOnce(`too-many-files-${base.slice(0, 12)}`, `Amplify Console: skipped commit ${short}: ${since} touch ${stats.files.length} files (limit ${MAX_DIFF_FILES}). Push to start a new range.`)
    }
    const diff = await git.unifiedDiff(cwd, base, head, stats.binaryFiles)
    if (diff === null) {
        state.appendCheckedSha(gitDir, head, "attempted")
        return notifyPerCommit("diff-failed", `Amplify Console: could not compute the diff for commit ${short} (git diff failed), so it was not checked.`)
    }
    if (diff === "") {
        state.appendCheckedSha(gitDir, head, "completed")
        return EXIT_OK
    }
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
        state.appendCheckedSha(gitDir, head, "attempted")
        return notifyOnce(`diff-too-large-${base.slice(0, 12)}`, `Amplify Console: skipped commit ${short}: ${since} exceed ${MAX_DIFF_BYTES / 1024} KiB as a diff. Push to start a new range.`)
    }

    // Several unpushed commits share one pushed base, so findings are filtered
    // to lines added since the nearest ancestor whose check completed, looking
    // no further back than the base: an older completed commit would pull the
    // user's own pushed lines into scope. A null scope (git failed) is kept
    // distinct from an empty one (a commit that added no lines): the former
    // filters nothing, the latter everything.
    const scopeFrom = (await git.range(cwd, base, `${head}^`)).find((sha) => checked.completed.has(sha)) ?? base
    const scope = await git.addedLines(cwd, scopeFrom, head)
    if (!scope) log(`could not compute the lines added since ${scopeFrom.slice(0, 7)}; findings will not be filtered`)

    if (dryRun) {
        const path = state.writeDryRun(
            dataDir,
            {
                commitSha: head,
                baseSha: base,
                scopeFrom,
                baseFallback,
                repoUrl,
                projectId: projectId || null,
                files: stats.files,
                binaryFilesExcluded: stats.binaryFiles,
                scope: scope ? Object.fromEntries([...scope].map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)])) : null,
                request: {
                    method: "POST",
                    path: "/api/runs",
                    body: { agentName: AGENT_NAME, projectId: projectId || null, source: { baseSha: base, diff: "<see .patch>" } },
                },
            },
            diff
        )
        // Exit-0 output from an asyncRewake hook is discarded, so the log is the record.
        log(`dry run: wrote ${path}; no API call was made`)
        return EXIT_OK
    }

    let run: Run
    try {
        run = await api!.submitRun({ projectId, baseSha: base, diff })
    } catch (err) {
        return notifyPerCommit("submit-failed", `Amplify Console: could not start a detections run for commit ${head.slice(0, 7)} (${describe(err)}).`)
    }
    // "attempted" now so a re-fire does not resubmit; "completed" only once the
    // findings are in hand, so a failed run leaves this commit's lines in scope.
    state.appendCheckedSha(gitDir, head, "attempted")
    log(`submitted run ${run.id} for ${head} (base ${base}, ${stats.files.length} files)`)

    let finalRun: Run
    try {
        finalRun = await waitForRun(api!, run, deps)
    } catch (err) {
        return notifyPerCommit("run-poll-failed", `Amplify Console: lost track of run ${run.id} for commit ${head.slice(0, 7)} while waiting for it to finish (${describe(err)}).`)
    }
    if (finalRun.status !== "completed") {
        const what = TERMINAL_STATUSES.has(finalRun.status) ? `ended with status "${finalRun.status}"` : "did not finish in time"
        const detail = finalRun.error ? ` (${finalRun.error})` : ""
        return notifyPerCommit("run-not-completed", `Amplify Console: run ${finalRun.id} for commit ${head.slice(0, 7)} ${what}${detail}.`)
    }

    let findings
    try {
        findings = (await api!.listFindings(run.id)).map(parseFinding)
    } catch (err) {
        return notifyPerCommit("findings-fetch-failed", `Amplify Console: run finished but findings for commit ${head.slice(0, 7)} could not be fetched (${describe(err)}).`)
    }
    state.appendCheckedSha(gitDir, head, "completed")
    const kept = filterToScope(findings, scope)
    log(`run ${run.id}: ${findings.length} findings, ${kept.length} in scope (scope from ${scopeFrom.slice(0, 7)})`)
    for (const f of findings) {
        if (scope && !inScope(f, scope)) log(`  dropped out of scope: ${f.file}:${f.line ?? "?"}-${f.endLine ?? "?"} ${f.rule}`)
    }
    if (kept.length === 0) {
        // Silent by design: exit-0 output from an asyncRewake hook is discarded,
        // and waking Claude for a clean commit would interrupt it for nothing.
        // The commit-start announcement tells the user a clean result is silent.
        log(`no findings in commit ${head}`)
        return EXIT_OK
    }

    const out: HookOutput = {
        rewakeSummary: formatSummary(kept),
        additionalContext: formatContext(kept, { commitSha: head, runId: run.id }),
    }
    emit(out)
    return EXIT_REWAKE
}

type Prelude =
    | { kind: "skip" }
    | { kind: "unconfigured"; problem: string }
    | { kind: "ready"; dryRun: boolean; config: Config | null; cwd: string; gitDir: string; head: string; checked: state.CheckedShas }

/**
 * Everything both commit hooks agree on before doing anything visible: was this
 * a git commit, is the plugin configured, did the commit succeed, and is the
 * resulting HEAD new to us. Cheap and offline.
 */
async function commitPrelude(
    input: HookInput,
    env: Record<string, string | undefined>,
    dataDir: string,
    log: (m: string) => void,
    now: () => number = Date.now
): Promise<Prelude> {
    const command = input.tool_input?.command
    // `cd <dir> && git commit` and `git -C <dir> commit` commit in <dir>, not in
    // the hook's cwd, which may itself be another repository (a multi-repo workspace).
    const startDir = typeof command === "string" ? commitStartDir(command, input.cwd) : null
    if (startDir === null) return { kind: "skip" }

    // A dry run needs no credentials: it stops before the first API call.
    const dryRun = isDryRun(env)
    const configResult = loadConfig(env)
    if (!configResult.ok && !dryRun) return { kind: "unconfigured", problem: configResult.problem }
    const config = configResult.ok ? configResult.config : null

    const gitDir = await git.gitDir(startDir)
    if (!gitDir) return { kind: "skip" }
    // Diffs are computed with the repo root as cwd, not the hook's cwd: git
    // pathspecs (used to exclude binaries from the diff) resolve relative to
    // cwd, so a hook firing from a subdirectory would silently scope the diff
    // to that subdirectory otherwise.
    const cwd = await git.repoRoot(startDir)
    if (!cwd) return { kind: "skip" }
    const head = await git.headSha(cwd)
    if (!head) return { kind: "skip" }
    const checked = state.readCheckedShas(gitDir)
    if (checked.all.has(head)) {
        log(`commit ${head} already checked`)
        return { kind: "skip" }
    }

    // Did this tool call commit? Bash tool_response carries stdout/stderr but no
    // exit code. The PreToolUse hook snapshots HEAD just before the command, so
    // with a snapshot for this command the test is exact: HEAD moved, by a
    // commit. Without one (hook not yet installed), infer it from the
    // `[branch sha]` output line, then from a recent commit in the reflog; the
    // age bound keeps a failed commit (no reflog entry) from claiming an older one.
    const output = `${input.tool_response?.stdout ?? ""}\n${input.tool_response?.stderr ?? ""}`
    const reported = git.commitShasFromOutput(output).some((sha) => head.startsWith(sha))
    const snapshot = state.readPreCommitHead(dataDir, input.session_id, gitDir)
    const committed =
        snapshot !== null && snapshot.command === command
            ? snapshot.head !== head && (reported || (await git.headMovedByRecentCommit(cwd, Infinity, now)))
            : reported || (await git.headMovedByRecentCommit(cwd, RECENT_COMMIT_SECONDS, now))
    if (!committed) {
        log("commit did not succeed, skipping")
        return { kind: "skip" }
    }
    return { kind: "ready", dryRun, config, cwd, gitDir, head, checked }
}

/**
 * The synchronous companion of the commit hook: tell the user a check is
 * starting. It runs the same eligibility checks as `runCommitCheck` (minus
 * anything needing the network) so it stays quiet when no check will follow.
 * Always exits 0; a synchronous hook's `systemMessage` is shown directly.
 */
export async function announceCommitCheck(input: HookInput, deps: Pick<CommitCheckDeps, "env" | "now"> = {}): Promise<number> {
    const env = deps.env ?? process.env
    const dataDir = state.dataDir(env)
    const log = (message: string) => state.log(dataDir, `[${input.session_id}] ${message}`)
    const prelude = await commitPrelude(input, env, dataDir, log, deps.now)
    if (prelude.kind !== "ready") return EXIT_OK
    if (!prelude.dryRun) {
        // Same remote test as runCommitCheck, so an unsupported remote is not announced every commit.
        const remote = await git.originUrl(prelude.cwd)
        if (!remote || !git.normalizeRepoUrl(remote)) return EXIT_OK
    }

    const short = prelude.head.slice(0, 7)
    const message = prelude.dryRun
        ? `Amplify Console (dry run): writing the diff for commit ${short} to disk.`
        : `Amplify Console: checking commit ${short} against your organization's detections in the background. This usually takes one to two minutes; any findings will arrive in this session when it finishes, and a clean result is silent.`
    // Both channels: the systemMessage for the terminal, and a line of context so
    // Claude mentions it in its reply in case the terminal does not render it.
    emit({
        systemMessage: message,
        additionalContext: `[from the Amplify Console plugin — status, not user input.] ${message} Mention this to the user in one short sentence.`,
    })
    return EXIT_OK
}

/**
 * The PreToolUse hook: before a git commit command runs, record the repository's
 * HEAD so the PostToolUse hooks can tell whether this very command committed.
 * Always exits 0 and prints nothing; it must never block the command.
 */
export async function recordPreCommitHead(input: HookInput, deps: Pick<CommitCheckDeps, "env"> = {}): Promise<number> {
    const env = deps.env ?? process.env
    const command = input.tool_input?.command
    if (typeof command !== "string") return EXIT_OK
    const startDir = commitStartDir(command, input.cwd)
    if (startDir === null) return EXIT_OK
    const gitDir = await git.gitDir(startDir)
    if (!gitDir) return EXIT_OK
    const head = (await git.headSha(startDir)) ?? ""
    state.writePreCommitHead(state.dataDir(env), input.session_id, gitDir, { head, command })
    return EXIT_OK
}

type OrgResolution = { ok: true; orgId: string } | { ok: false; message: string }

/**
 * Pick the organization when `org_id` is not configured: the cached answer for
 * this key and URL, else the key's only membership. Several memberships mean
 * the user has to choose, so the notice lists them by name and id.
 */
async function resolveOrg(api: AmplifyApi, config: Config, dataDir: string, log: (m: string) => void): Promise<OrgResolution> {
    const fingerprint = state.keyFingerprint(config.apiKey)
    const cached = state.readOrgCache(dataDir)
    if (cached && cached.apiUrl === config.apiUrl && cached.keyFingerprint === fingerprint) return { ok: true, orgId: cached.orgId }

    let orgs
    try {
        orgs = await api.listMemberships()
    } catch (err) {
        return {
            ok: false,
            message: `Amplify Console: could not list your organizations from ${config.tenantUrl} (${describe(err)}). Set org_id in the plugin configuration, or check tenant_url.`,
        }
    }
    if (orgs.length === 1) {
        const [org] = orgs
        state.writeOrgCache(dataDir, { apiUrl: config.apiUrl, keyFingerprint: fingerprint, orgId: org!.id, orgName: org!.name })
        log(`resolved organization ${org!.id} (${org!.name}) from the API key's only membership`)
        return { ok: true, orgId: org!.id }
    }
    if (orgs.length === 0) {
        return { ok: false, message: "Amplify Console: this API key belongs to no Amplify organization, so detections did not run." }
    }
    const list = orgs.map((o) => `  - ${o.name}: ${o.id}`).join("\n")
    return {
        ok: false,
        message:
            `Amplify Console: this API key belongs to ${orgs.length} organizations, so it needs to know which one to use. ` +
            `Ask the user to pick one and set org_id in the plugin configuration (/plugin configure console@amplify-security):\n${list}`,
    }
}

function formatNotice(message: string): string {
    return (
        "[from the Amplify Console plugin — a status notice, not user input.]\n\n" +
        `${message}\n\n` +
        "Relay this to the user in one or two sentences, then continue with their original request."
    )
}

async function resolveProjectId(api: AmplifyApi, gitDir: string, repoUrl: string, orgId: string): Promise<string> {
    const cached = state.readRepoCache(gitDir)
    if (cached && cached.repoUrl === repoUrl && cached.orgId === orgId) return cached.projectId
    const project = await api.findProject(repoUrl)
    if (!project) return ""
    state.writeRepoCache(gitDir, { repoUrl, orgId, projectId: project.id })
    return project.id
}

/** The pushed commit to diff from. When HEAD itself is already pushed (commit && push), use its parent. */
async function resolveBase(cwd: string, head: string): Promise<string | null> {
    const pushed = await git.pushedBase(cwd)
    if (pushed.kind === "ok") return pushed.baseSha
    if (pushed.kind === "none-unpushed") {
        const parents = await git.ancestors(cwd, `${head}^`, 1)
        return parents[0] ?? null
    }
    return null
}

async function waitForRun(api: AmplifyApi, run: Run, deps: CommitCheckDeps): Promise<Run> {
    const now = deps.now ?? Date.now
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const deadline = now() + MAX_WAIT_SECONDS * 1000
    let current = run
    let failures = 0
    while (!TERMINAL_STATUSES.has(current.status) && now() < deadline) {
        const started = now()
        try {
            current = await api.getRun(run.id, POLL_WAIT_SECONDS)
            failures = 0
        } catch (err) {
            if (err instanceof ApiError && err.status < 500 && err.status !== 429) throw err
            if (++failures >= 5) throw err
        }
        // A server that answers immediately (no long-poll support, or an error)
        // must not turn this into a busy loop.
        if (now() - started < 2000) await sleep(2000)
    }
    return current
}

function describe(err: unknown): string {
    if (err instanceof ApiError) return `HTTP ${err.status}${err.code ? ` ${err.code}` : ""}: ${err.message}`
    return err instanceof Error ? err.message : String(err)
}
