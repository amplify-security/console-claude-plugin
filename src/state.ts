/**
 * Persistent bookkeeping.
 *
 * Two homes:
 *  - the plugin data directory (CLAUDE_PLUGIN_DATA, survives plugin updates):
 *    per-session once-only markers and the debug log;
 *  - the target repo's .git directory: which commits have already been
 *    checked, and the cached Amplify project id for the repo. Repo-local so it
 *    survives across sessions and works per checkout.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Write-then-rename so a reader never observes a half-written file. */
function writeFileAtomic(path: string, content: string): void {
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`
    writeFileSync(tmpPath, content)
    renameSync(tmpPath, path)
}

export function dataDir(env: Record<string, string | undefined> = process.env): string {
    // Claude Code names the directory <plugin>-<marketplace>.
    return env.CLAUDE_PLUGIN_DATA ?? join(homedir(), ".claude", "plugins", "data", "console-amplify-security")
}

/** True the first time `key` is seen for this session; false afterwards. */
export function firstTimeThisSession(dir: string, sessionId: string, key: string): boolean {
    const sessionDir = join(dir, "sessions", sessionId.replace(/[^A-Za-z0-9_-]/g, "_"))
    const marker = join(sessionDir, key)
    if (existsSync(marker)) return false
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(marker, new Date().toISOString())
    return true
}

export function log(dir: string, message: string): void {
    try {
        mkdirSync(dir, { recursive: true })
        appendFileSync(join(dir, "log.txt"), `${new Date().toISOString()} ${message}\n`)
    } catch {
        // Logging must never break a hook.
    }
}

const CHECKED_FILE = "amplify-checked-shas"
const CHECKED_CAP = 500

/** `attempted`: a check was started or the commit was skipped. `completed`: its run finished and findings were delivered. */
export type CheckStatus = "attempted" | "completed"

export interface CheckedShas {
    /** Every commit with any record: what not to check again. */
    all: Set<string>
    /** Commits whose lines have actually been reviewed: where the next commit's scope may start. */
    completed: Set<string>
}

/** One line per record, `sha<TAB>time<TAB>status`; a commit can have an attempted and a later completed line. */
export function readCheckedShas(gitDir: string): CheckedShas {
    const result: CheckedShas = { all: new Set(), completed: new Set() }
    const path = join(gitDir, CHECKED_FILE)
    if (!existsSync(path)) return result
    const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .slice(-CHECKED_CAP)
    for (const line of lines) {
        const [sha, , status] = line.split("\t")
        if (!sha?.trim()) continue
        result.all.add(sha.trim())
        // Lines from before the status column existed count as completed.
        if (status === undefined || status.trim() === "completed") result.completed.add(sha.trim())
    }
    return result
}

/**
 * Append-only: two concurrent hook invocations for the same repo each append
 * their own line, so neither can clobber the other's entry the way a
 * read-modify-write would. The cap is enforced lazily by readCheckedShas
 * instead of trimming here.
 */
export function appendCheckedSha(gitDir: string, sha: string, status: CheckStatus): void {
    appendFileSync(join(gitDir, CHECKED_FILE), `${sha}\t${new Date().toISOString()}\t${status}\n`)
}

export interface OrgCache {
    apiUrl: string
    /** Prefix of a SHA-256 of the API key, so a key change invalidates the cache without storing the key. */
    keyFingerprint: string
    orgId: string
    orgName: string
}

const ORG_FILE = "org.json"

export function keyFingerprint(apiKey: string): string {
    return new Bun.CryptoHasher("sha256").update(apiKey).digest("hex").slice(0, 16)
}

export function readOrgCache(dir: string): OrgCache | null {
    const path = join(dir, ORG_FILE)
    if (!existsSync(path)) return null
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OrgCache>
        if (typeof parsed.apiUrl === "string" && typeof parsed.keyFingerprint === "string" && typeof parsed.orgId === "string") {
            return { apiUrl: parsed.apiUrl, keyFingerprint: parsed.keyFingerprint, orgId: parsed.orgId, orgName: parsed.orgName ?? "" }
        }
    } catch {
        // Corrupt cache: treat as absent.
    }
    return null
}

export function writeOrgCache(dir: string, cache: OrgCache): void {
    mkdirSync(dir, { recursive: true })
    writeFileAtomic(join(dir, ORG_FILE), JSON.stringify(cache, null, 2) + "\n")
}

export interface RepoCache {
    repoUrl: string
    /** Project ids are per organization, so a cache entry is only valid for the org it was looked up in. */
    orgId: string
    projectId: string
}

const CACHE_FILE = "amplify-console.json"

export function readRepoCache(gitDir: string): RepoCache | null {
    const path = join(gitDir, CACHE_FILE)
    if (!existsSync(path)) return null
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            typeof (parsed as RepoCache).repoUrl === "string" &&
            typeof (parsed as RepoCache).orgId === "string" &&
            typeof (parsed as RepoCache).projectId === "string"
        ) {
            return parsed as RepoCache
        }
    } catch {
        // Corrupt cache: treat as absent.
    }
    return null
}

export function writeRepoCache(gitDir: string, cache: RepoCache): void {
    writeFileAtomic(join(gitDir, CACHE_FILE), JSON.stringify(cache, null, 2) + "\n")
}

export interface DryRunRecord {
    commitSha: string
    baseSha: string
    scopeFrom: string
    /** Set when the dry run had to invent a base the real run would not use. */
    baseFallback?: string
    repoUrl: string | null
    projectId: string | null
    files: string[]
    binaryFilesExcluded: string[]
    /** Null when the added lines could not be computed. */
    scope: Record<string, number[]> | null
    request: unknown
}

/** Write the diff and its request metadata for review; returns the diff path. */
export function writeDryRun(dir: string, record: DryRunRecord, diff: string): string {
    const outDir = join(dir, "dry-run")
    mkdirSync(outDir, { recursive: true })
    const stem = join(outDir, record.commitSha.slice(0, 12))
    writeFileSync(`${stem}.patch`, diff)
    writeFileSync(`${stem}.json`, JSON.stringify(record, null, 2) + "\n")
    return `${stem}.patch`
}
