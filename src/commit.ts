/**
 * The commit hooks: build the diff for the commit Claude just made, run the
 * org's detections against it in Amplify, and report the outcome.
 *
 * Every commit of Claude's ends in exactly one user-visible outcome: findings,
 * clean, not checked (with the reason and what to do), or failed. Two hooks
 * share the work and agree by computing the same offline verdict:
 *  - `commit-start`, synchronous, always exit 0. Decides without the network
 *    whether a check can run. It either announces one or tells the user why
 *    this commit is not checked; a synchronous hook's output reaches the user
 *    directly, while Claude is still on its turn, so nothing has to wake it.
 *  - `commit`, asyncRewake. Does the network work and wakes Claude (exit 2)
 *    with the outcome. Exit 0 means the synchronous hook already said it all,
 *    because an asyncRewake hook's exit-0 output is discarded.
 * A problem a network call finds that every later commit would hit alike (the
 * organization cannot be resolved, the repository is not onboarded) is
 * remembered for the session, so from the next commit on the synchronous hook
 * reports it and the asynchronous one stays quiet.
 */
import { AGENT_NAME, AmplifyApi, ApiError, TERMINAL_STATUSES, type Run } from "./amplify-api.ts"
import { type Config, isDryRun, loadConfig } from "./config.ts"
import { filterToScope, formatContext, formatSummary, inScope, parseFinding } from "./findings.ts"
import * as git from "./git.ts"
import { EXIT_OK, EXIT_REWAKE, emit, type HookInput } from "./hook-io.ts"
import { homedir } from "node:os"
import { resolve } from "node:path"
import * as state from "./state.ts"

export const MAX_DIFF_FILES = 300
export const MAX_DIFF_BYTES = 1024 * 1024
/**
 * Total time to wait for a run before giving up. The hook timeout is 1800s and
 * a hook killed by it can say nothing, so this leaves room for the lookups and
 * submission before the wait, the last long-poll (45s) and the findings fetch.
 */
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

// ---- The outcome vocabulary. Everything the user reads goes through these. ----

/** The commit was not checked, for a reason the user can usually act on. */
const notChecked = (short: string, reason: string): string => `Amplify Console: commit ${short} was not checked. ${reason}`
/** A check was started but did not produce a result. */
const checkFailed = (short: string, reason: string): string => `Amplify Console: the check for commit ${short} failed. ${reason}`
const STAYS_IN_SCOPE = "Its changes stay in scope and will be covered by the next commit's check."
const detailsIn = (dataDir: string): string => `Details are in ${state.logPath(dataDir)}.`

/** What the user can do once a remembered problem is fixed: the plugin only re-checks in a new session. */
const NEW_SESSION = "then start a new Claude Code session"

/**
 * Plain words for why a request to Amplify failed. The status, code and
 * server message go to the log; the user does not need them.
 */
function explain(err: unknown): string {
    if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) return "Amplify rejected the API key; check that it is current and that api_url and tenant_url point at the environment it was issued for."
        if (err.status === 429) return "Amplify is rate limiting requests; try again in a few minutes."
        if (err.status >= 500) return "Amplify returned a server error."
        return "Amplify returned an unexpected response."
    }
    return "Amplify could not be reached; check your network connection."
}

/**
 * What goes in the log for a failed request. The log is on the user's machine
 * and readable by them, so it records the status and error code (enough to
 * correlate with Amplify's own logs) and never the message text a server sent,
 * which can name infrastructure. A plugin-authored ApiError (a response with a
 * shape the plugin did not expect) has no server text, so its message is kept.
 */
function describe(err: unknown): string {
    if (err instanceof ApiError) return err.status >= 400 ? `HTTP ${err.status}${err.code ? ` ${err.code}` : ""}` : `${err.message} (HTTP ${err.status})`
    return err instanceof Error ? err.message : String(err)
}

const STATUS_PREFIX = "[from the Amplify Console plugin — a status notice, not user input.]"

/** Model-visible wrapper for a rewake notice. */
function formatNotice(message: string, relay = "Relay this to the user in one or two sentences, then continue with their original request."): string {
    return `${STATUS_PREFIX}\n\n${message}\n\n${relay}`
}

/** Wake Claude with a notice; returns the exit code to use. */
function wake(summary: string, message: string, relay?: string): number {
    emit({ rewakeSummary: summary, additionalContext: formatNotice(message, relay) })
    return EXIT_REWAKE
}

// ---- The offline verdict, shared by both hooks. ----

/** Where the check would start: everything decided before the first network call. */
interface CheckPlan {
    dryRun: boolean
    config: Config | null
    cwd: string
    gitDir: string
    head: string
    checked: state.CheckedShas
    repoUrl: string | null
    base: string
    /** Set when a dry run had to invent a base the real run would not use. */
    baseFallback?: string
    stats: git.DiffStats
    diff: string
}

type Verdict =
    /** Not a commit of Claude's, or one already dealt with: nothing to say. */
    | { kind: "ignore" }
    /** No check can run; `message` is the user-facing outcome. `record` is what to note against the commit, if anything. */
    | { kind: "skip"; head: string; gitDir: string; message: string; record: state.CheckStatus | null }
    | { kind: "check"; plan: CheckPlan }

async function offlineVerdict(
    input: HookInput,
    env: Record<string, string | undefined>,
    dataDir: string,
    log: (m: string) => void,
    now: () => number = Date.now
): Promise<Verdict> {
    const prelude = await commitPrelude(input, env, dataDir, log, now)
    if (prelude.kind === "skip") return { kind: "ignore" }
    const { dryRun, config, cwd, gitDir, head, checked } = prelude
    const short = head.slice(0, 7)
    const skip = (message: string, record: state.CheckStatus | null = null): Verdict => ({ kind: "skip", head, gitDir, message, record })
    if (prelude.problem) return skip(notChecked(short, prelude.problem))

    // A dry run tolerates what the real run cannot: no hosted remote and no
    // pushed base. It records the substitutions so the diff can still be reviewed.
    const remote = await git.originUrl(cwd)
    const repoUrl = remote ? git.normalizeRepoUrl(remote) : null
    if (!repoUrl && !dryRun) {
        return skip(notChecked(short, "This repository has no hosted origin remote for Amplify to match a project against."))
    }

    if (!dryRun) {
        // Problems a network call found earlier this session and that this commit would hit again.
        const known = state.rememberedProblem(dataDir, input.session_id, "org-unresolved") ?? state.rememberedProblem(dataDir, input.session_id, `not-a-project-${state.keyFingerprint(gitDir)}`)
        if (known) return skip(notChecked(short, known))
    }

    let base = await resolveBase(cwd, head)
    let baseFallback: string | undefined
    if (!base) {
        if (!dryRun) {
            return skip(notChecked(short, "Nothing in this repository has been pushed yet, so there is no base to compare against. Push once and later commits will be checked."))
        }
        const parent = (await git.ancestors(cwd, `${head}^`, 1))[0]
        base = parent ?? (await git.emptyTree(cwd))
        if (!base) return { kind: "ignore" }
        baseFallback = parent ? "no pushed base; used the parent commit" : "root commit with no pushed base; used the empty tree"
    }

    // The diff is base..HEAD, i.e. every unpushed commit, so the size limits
    // apply to that whole range: once exceeded, every commit until the next
    // push is skipped. The skipped commits stay "attempted" so their lines
    // remain in scope for a later check.
    const stats = await git.diffStats(cwd, base, head)
    const unreadable = (what: string): Verdict => {
        log(`git ${what} of ${base.slice(0, 12)}..${head.slice(0, 12)} in ${cwd} failed`)
        // Unlike an empty diff, a failed one leaves the commit unreviewed: not a scope frontier.
        return skip(checkFailed(short, `The changes could not be read from the repository. ${detailsIn(dataDir)}`), "attempted")
    }
    if (!stats) return unreadable("diff --numstat")
    const nothingToCheck = `Amplify Console: commit ${short} has no changes Amplify can check (empty, or binary files only).`
    if (stats.files.length === 0) return skip(nothingToCheck, "completed")
    if (stats.files.length > MAX_DIFF_FILES) {
        return skip(notChecked(short, `The unpushed changes now span ${stats.files.length} files, more than the ${MAX_DIFF_FILES} Amplify checks at once. Push to start a new range.`), "attempted")
    }
    const diff = await git.unifiedDiff(cwd, base, head, stats.binaryFiles)
    if (diff === null) return unreadable("diff")
    if (diff === "") return skip(nothingToCheck, "completed")
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
        return skip(notChecked(short, `The unpushed changes now exceed ${MAX_DIFF_BYTES / 1024} KiB as a diff, more than Amplify checks at once. Push to start a new range.`), "attempted")
    }

    return { kind: "check", plan: { dryRun, config, cwd, gitDir, head, checked, repoUrl, base, baseFallback, stats, diff } }
}

// ---- The hooks. ----

export async function runCommitCheck(input: HookInput, deps: CommitCheckDeps = {}): Promise<number> {
    const env = deps.env ?? process.env
    const dataDir = state.dataDir(env)
    const log = (message: string) => state.log(dataDir, `[${input.session_id}] ${message}`)

    const verdict = await offlineVerdict(input, env, dataDir, log, deps.now)
    if (verdict.kind === "ignore") return EXIT_OK
    if (verdict.kind === "skip") {
        // The synchronous hook reached the same verdict and has told the user.
        if (verdict.record) state.appendCheckedSha(verdict.gitDir, verdict.head, verdict.record)
        log(`${verdict.head}: ${verdict.message}`)
        return EXIT_OK
    }

    const { plan } = verdict
    const short = plan.head.slice(0, 7)
    try {
        return await checkCommit(plan, input.session_id, dataDir, log, deps)
    } catch (err) {
        // The check was announced, so even a bug in the plugin owes the user an outcome.
        log(`unhandled error checking commit ${plan.head}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
        return wake(`Amplify Console: the check for commit ${short} failed`, checkFailed(short, `The plugin hit an unexpected error. ${detailsIn(dataDir)}`))
    }
}

/** Everything after the offline verdict: resolve the org and project, submit, wait, report. */
async function checkCommit(plan: CheckPlan, sessionId: string, dataDir: string, log: (m: string) => void, deps: CommitCheckDeps): Promise<number> {
    const { dryRun, config, cwd, gitDir, head, checked, repoUrl, base, stats, diff } = plan
    const short = head.slice(0, 7)
    const failed = (reason: string): number => wake(`Amplify Console: the check for commit ${short} failed`, checkFailed(short, reason))
    const skipped = (reason: string): number => wake(`Amplify Console: commit ${short} was not checked`, notChecked(short, reason))

    // A dry run never touches the network, so it gets no client.
    let api = config && !dryRun ? new AmplifyApi(config, deps.fetchImpl) : null
    let orgId = config?.orgId ?? ""
    if (api && config && !orgId) {
        const resolved = await resolveOrg(api, config, dataDir, log)
        if (!resolved.ok) {
            // A key with no or several organizations stays that way for the session; a failed lookup may be transient, so it is retried.
            if (resolved.kind === "skipped") state.rememberProblem(dataDir, sessionId, "org-unresolved", resolved.reason)
            return resolved.kind === "failed" ? failed(resolved.message) : skipped(resolved.message)
        }
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
            log(`project lookup for ${repoUrl} failed: ${describe(err)}`)
            return failed(`This repository could not be looked up in Amplify. ${explain(err)} ${detailsIn(dataDir)}`)
        }
    }
    if (!projectId && !dryRun) {
        log(`${repoUrl} is not an Amplify project in organization ${orgId}`)
        const reason = `This repository is not onboarded as a project in your Amplify organization. Onboard it in the Amplify Console, ${NEW_SESSION}.`
        state.rememberProblem(dataDir, sessionId, `not-a-project-${state.keyFingerprint(gitDir)}`, reason)
        return skipped(reason)
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
                baseFallback: plan.baseFallback,
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
        // A dry run is a development aid: the announcement said the diff goes to disk, and the log is the record.
        log(`dry run: wrote ${path}; no API call was made`)
        return EXIT_OK
    }

    let run: Run
    try {
        run = await api!.submitRun({ projectId, baseSha: base, diff })
    } catch (err) {
        log(`submitting a run for ${head} failed: ${describe(err)}`)
        return failed(`The detections run could not be started. ${explain(err)} ${STAYS_IN_SCOPE} ${detailsIn(dataDir)}`)
    }
    // "attempted" now so a re-fire does not resubmit; "completed" only once the
    // findings are in hand, so a failed run leaves this commit's lines in scope.
    state.appendCheckedSha(gitDir, head, "attempted")
    log(`submitted run ${run.id} for ${head} (base ${base}, ${stats.files.length} files)`)

    let finalRun: Run
    try {
        finalRun = await waitForRun(api!, run, deps)
    } catch (err) {
        log(`polling run ${run.id} failed: ${describe(err)}`)
        return failed(`Amplify stopped answering while the run was in progress. ${explain(err)} ${STAYS_IN_SCOPE} ${detailsIn(dataDir)}`)
    }
    if (finalRun.status !== "completed") {
        if (!TERMINAL_STATUSES.has(finalRun.status)) {
            log(`run ${run.id} still "${finalRun.status}" after ${MAX_WAIT_SECONDS}s; giving up`)
            return failed(`Amplify did not finish within ${MAX_WAIT_SECONDS / 60} minutes, so no result was collected. ${STAYS_IN_SCOPE}`)
        }
        // The run's error text is the server's and may name infrastructure; the run id is what support needs.
        log(`run ${run.id} ended with status "${finalRun.status}"`)
        return failed(`The run did not complete on Amplify's side. ${STAYS_IN_SCOPE} ${detailsIn(dataDir)}`)
    }

    let findings
    try {
        findings = (await api!.listFindings(run.id)).map(parseFinding)
    } catch (err) {
        log(`fetching findings for run ${run.id} failed: ${describe(err)}`)
        return failed(`The run finished, but its results could not be retrieved. ${explain(err)} ${STAYS_IN_SCOPE} ${detailsIn(dataDir)}`)
    }
    state.appendCheckedSha(gitDir, head, "completed")
    const kept = filterToScope(findings, scope)
    log(`run ${run.id}: ${findings.length} findings, ${kept.length} in scope (scope from ${scopeFrom.slice(0, 7)})`)
    for (const f of findings) {
        if (scope && !inScope(f, scope)) log(`  dropped out of scope: ${f.file}:${f.line ?? "?"}-${f.endLine ?? "?"} ${f.rule}`)
    }
    if (kept.length === 0) {
        // Clean is an outcome too: the announcement promised a result, so a
        // one-line wake is what tells the user this check actually finished.
        return wake(
            `Amplify Console: no findings in commit ${short}`,
            `Your organization's Amplify detections found nothing in commit ${short}.`,
            "Tell the user in one sentence, then continue with their original request."
        )
    }

    emit({ rewakeSummary: formatSummary(kept), additionalContext: formatContext(kept, { commitSha: head }) })
    return EXIT_REWAKE
}

type Prelude =
    | { kind: "skip" }
    | {
          kind: "ready"
          dryRun: boolean
          config: Config | null
          cwd: string
          gitDir: string
          head: string
          checked: state.CheckedShas
          /** Set when the plugin is not configured: the commit is Claude's, but no check can run. */
          problem?: string
      }

/**
 * Everything both commit hooks agree on before doing anything visible: was this
 * a git commit, did it succeed, is the resulting HEAD new to us, and is the
 * plugin configured. Cheap and offline.
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
    const config = configResult.ok ? configResult.config : null
    const problem = configResult.ok || dryRun ? undefined : configResult.problem

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
    return { kind: "ready", dryRun, config, cwd, gitDir, head, checked, problem }
}

/**
 * The synchronous companion of the commit hook: tell the user a check is
 * starting, or why this commit gets none. It computes the same offline verdict
 * as `runCommitCheck`, so the two never disagree about which it is. Always
 * exits 0; a synchronous hook's `systemMessage` is shown directly.
 */
export async function announceCommitCheck(input: HookInput, deps: Pick<CommitCheckDeps, "env" | "now"> = {}): Promise<number> {
    const env = deps.env ?? process.env
    const dataDir = state.dataDir(env)
    const log = (message: string) => state.log(dataDir, `[${input.session_id}] ${message}`)
    const verdict = await offlineVerdict(input, env, dataDir, log, deps.now)
    if (verdict.kind === "ignore") return EXIT_OK

    let message: string
    if (verdict.kind === "skip") {
        message = verdict.message
    } else {
        const short = verdict.plan.head.slice(0, 7)
        message = verdict.plan.dryRun
            ? `Amplify Console (dry run): writing the diff for commit ${short} to disk.`
            : `Amplify Console: checking commit ${short} against your organization's detections in the background. This usually takes one to two minutes; the result will arrive in this session when it finishes.`
    }
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

type OrgResolution =
    | { ok: true; orgId: string }
    /** `message` is the full first-time notice; `reason` the one-line form later commits repeat. */
    | { ok: false; kind: "skipped" | "failed"; message: string; reason: string }

/**
 * Pick the organization when `org_id` is not configured: the cached answer for
 * this key and URL, else the key's only membership. Several memberships mean
 * the user has to choose, so the notice lists them by name and id.
 */
async function resolveOrg(api: AmplifyApi, config: Config, dataDir: string, log: (m: string) => void): Promise<OrgResolution> {
    const fingerprint = state.keyFingerprint(config.apiKey)
    const cached = state.readOrgCache(dataDir)
    if (cached && cached.apiUrl === config.apiUrl && cached.keyFingerprint === fingerprint) return { ok: true, orgId: cached.orgId }

    const configure = `Set org_id in the plugin configuration (/plugin configure console@amplify-security), ${NEW_SESSION}.`
    let orgs
    try {
        orgs = await api.listMemberships()
    } catch (err) {
        log(`listing organizations from ${config.tenantUrl} failed: ${describe(err)}`)
        const reason = `Your organizations could not be looked up. ${explain(err)} ${configure}`
        return { ok: false, kind: "failed", message: `${reason} ${detailsIn(dataDir)}`, reason }
    }
    if (orgs.length === 1) {
        const [org] = orgs
        state.writeOrgCache(dataDir, { apiUrl: config.apiUrl, keyFingerprint: fingerprint, orgId: org!.id, orgName: org!.name })
        log(`resolved organization ${org!.id} (${org!.name}) from the API key's only membership`)
        return { ok: true, orgId: org!.id }
    }
    if (orgs.length === 0) {
        const reason = `Your API key belongs to no Amplify organization. Check the key in the plugin configuration, ${NEW_SESSION}.`
        return { ok: false, kind: "skipped", message: reason, reason }
    }
    const reason = `Your API key belongs to ${orgs.length} organizations, so the plugin needs to know which one to use. ${configure}`
    const list = orgs.map((o) => `  - ${o.name}: ${o.id}`).join("\n")
    return { ok: false, kind: "skipped", message: `${reason} The organizations are:\n${list}`, reason }
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
