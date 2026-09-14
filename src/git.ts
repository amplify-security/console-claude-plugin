/**
 * Git operations for building the commit diff the endpoint consumes.
 *
 * The ad-hoc runs endpoint clones the project at `baseSha` and applies `diff`,
 * so the base must already exist on a remote. "Pushed base" here means the
 * first parent of the oldest commit reachable from HEAD but from no remote ref.
 */
import { realpathSync } from "node:fs"
import { isAbsolute, join } from "node:path"

export interface GitResult {
    code: number
    stdout: string
    stderr: string
}

const GIT_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false"]
/** Force the `a/` `b/` header prefixes the server's `git apply` expects, whatever the user's `diff.noprefix` / `diff.mnemonicPrefix`. */
const DIFF_PREFIX = ["--src-prefix=a/", "--dst-prefix=b/"]

export async function git(cwd: string, args: string[]): Promise<GitResult> {
    const proc = Bun.spawn(["git", ...GIT_CONFIG, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    return { code, stdout, stderr }
}

async function gitOut(cwd: string, args: string[]): Promise<string | null> {
    const result = await git(cwd, args)
    return result.code === 0 ? result.stdout.trimEnd() : null
}

export async function repoRoot(cwd: string): Promise<string | null> {
    return gitOut(cwd, ["rev-parse", "--show-toplevel"])
}

/** The repository's shared git directory: the main `.git` even from a linked worktree, so repo-wide state is not split per worktree. */
export async function gitDir(cwd: string): Promise<string | null> {
    const dir = await gitOut(cwd, ["rev-parse", "--git-common-dir"])
    if (dir === null) return null
    // Canonical, so state lands in one place however the hook's cwd was spelled (symlinks, `..`).
    return realpathSync(isAbsolute(dir) ? dir : join(cwd, dir))
}

export async function headSha(cwd: string): Promise<string | null> {
    return gitOut(cwd, ["rev-parse", "HEAD"])
}

export async function originUrl(cwd: string): Promise<string | null> {
    return gitOut(cwd, ["remote", "get-url", "origin"])
}

/**
 * Normalize any clone URL form to the `https://host/owner/repo.git` form the
 * Amplify projects table stores (the provider's clone_url). Returns null for
 * anything that does not look like a hosted repository URL.
 */
export function normalizeRepoUrl(raw: string): string | null {
    const url = raw.trim()
    let host: string
    let path: string

    const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(url)
    if (scp) {
        host = scp[1]!
        path = scp[2]!
    } else {
        let parsed: URL
        try {
            parsed = new URL(url)
        } catch {
            return null
        }
        if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null
        // For http(s), `host` keeps a non-default port, which the stored clone
        // URL carries too (WHATWG URL already drops the scheme default). An
        // ssh:// or git:// port belongs to that protocol, not to the https URL.
        host = parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.host : parsed.hostname
        path = parsed.pathname
    }

    path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "")
    if (!host || path.split("/").length < 2) return null
    return `https://${host}/${path}.git`
}

export type PushedBase = { kind: "none-unpushed" } | { kind: "no-pushed-base" } | { kind: "ok"; baseSha: string }

/**
 * Find the nearest ancestor of HEAD that exists on `origin`. Only origin counts:
 * the project is resolved from origin's URL and the server verifies the base
 * against that repository, so a commit pushed only to a fork is not a base.
 */
export async function pushedBase(cwd: string): Promise<PushedBase> {
    // `--boundary` lists, prefixed with `-`, the excluded commits adjacent to the
    // unpushed ones: exactly the pushed parents. Taking "the parent of the last
    // listed commit" instead would trust commit-date order, which merges and
    // odd committer dates break.
    const out = await gitOut(cwd, ["rev-list", "--boundary", "HEAD", "--not", "--remotes=origin"])
    if (out === null) return { kind: "no-pushed-base" }
    const lines = out.split("\n").filter(Boolean)
    if (lines.length === 0) return { kind: "none-unpushed" }
    const boundary = lines.find((line) => line.startsWith("-"))
    if (!boundary) return { kind: "no-pushed-base" }
    return { kind: "ok", baseSha: boundary.slice(1) }
}

/** Commits reachable from `tip` but not from `base`, newest first. */
export async function range(cwd: string, base: string, tip: string): Promise<string[]> {
    const out = await gitOut(cwd, ["rev-list", tip, `^${base}`])
    return out === null ? [] : out.split("\n").filter(Boolean)
}

export interface DiffStats {
    files: string[]
    binaryFiles: string[]
}

export async function diffStats(cwd: string, from: string, to: string): Promise<DiffStats | null> {
    const out = await gitOut(cwd, ["diff", "--numstat", "--no-renames", from, to])
    if (out === null) return null
    const files: string[] = []
    const binaryFiles: string[] = []
    for (const line of out.split("\n").filter(Boolean)) {
        const [added, deleted, path] = line.split("\t")
        if (!path) continue
        if (added === "-" && deleted === "-") binaryFiles.push(path)
        else files.push(path)
    }
    return { files, binaryFiles }
}

/**
 * Unified diff from `from` to `to`, excluding binary files so it stays applyable and small.
 * Returned verbatim (no trimming): the server feeds it to `git apply`, which needs the final newline.
 */
export async function unifiedDiff(cwd: string, from: string, to: string, exclude: string[]): Promise<string | null> {
    const pathspec = exclude.length > 0 ? ["--", ".", ...exclude.map((p) => `:(exclude,literal)${p}`)] : []
    const result = await git(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-renames", ...DIFF_PREFIX, from, to, ...pathspec])
    return result.code === 0 ? result.stdout : null
}

/** Added-line numbers per file (paths as of `to`) between two commits. */
export async function addedLines(cwd: string, from: string, to: string): Promise<Map<string, Set<number>> | null> {
    const out = await gitOut(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-renames", "--unified=0", ...DIFF_PREFIX, from, to])
    if (out === null) return null
    return parseAddedLines(out)
}

export function parseAddedLines(diff: string): Map<string, Set<number>> {
    const result = new Map<string, Set<number>>()
    let current: Set<number> | null = null
    // New-side lines still to come in the current hunk. While there are any, a
    // line is content, not a header: added text starting with `++ ` would
    // otherwise read as a `+++ ` file header.
    let remaining = 0
    for (const line of diff.split("\n")) {
        if (remaining > 0) {
            if (line.startsWith("+") || line.startsWith(" ")) remaining--
            continue
        }
        if (line.startsWith("+++ ")) {
            // git appends a TAB after a path that contains whitespace.
            const target = line.slice(4).split("\t")[0]!
            if (target === "/dev/null") {
                current = null
                continue
            }
            const path = target.startsWith("b/") ? target.slice(2) : target
            current = new Set()
            result.set(path, current)
            continue
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
        if (hunk) {
            const start = Number(hunk[1])
            const count = hunk[2] === undefined ? 1 : Number(hunk[2])
            remaining = count
            if (current) for (let i = 0; i < count; i++) current.add(start + i)
        }
    }
    return result
}

/** Commit SHAs that the shell output of a `git commit` reports, e.g. `[main abc1234] msg`. */
export function commitShasFromOutput(output: string): string[] {
    const shas: string[] = []
    for (const match of output.matchAll(/^\[[^\]\n]*?\b([0-9a-f]{7,40})\]/gm)) shas.push(match[1]!)
    return shas
}

/** Up to `max` ancestors of `ref`, newest first (excluding `ref` itself when `ref` ends in `^`). */
export async function ancestors(cwd: string, ref: string, max: number): Promise<string[]> {
    const out = await gitOut(cwd, ["rev-list", `--max-count=${max}`, ref])
    return out === null ? [] : out.split("\n").filter(Boolean)
}

/**
 * Whether HEAD's most recent reflog entry was written by a commit (incl. amend)
 * within the last `maxAgeSeconds`. A failed `git commit` writes no reflog entry,
 * so without the age bound the previous, possibly user-made, commit would pass.
 */
export async function headMovedByRecentCommit(cwd: string, maxAgeSeconds: number, now: () => number = Date.now): Promise<boolean> {
    const out = await gitOut(cwd, ["reflog", "-1", "--date=unix", "--format=%gs%x09%gd"])
    if (out === null) return false
    const [subject, selector] = out.split("\t")
    const at = /@\{(\d+)\}$/.exec(selector ?? "")
    if (!subject || !at || !/^commit\b/.test(subject)) return false
    return now() / 1000 - Number(at[1]) <= maxAgeSeconds
}

/** The hash of the empty tree, for diffing a root commit against nothing. */
export async function emptyTree(cwd: string): Promise<string | null> {
    return gitOut(cwd, ["hash-object", "-t", "tree", "/dev/null"])
}
