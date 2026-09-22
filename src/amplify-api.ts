/**
 * The Amplify API contract, in one place.
 *
 * Every request and response shape the plugin depends on is encoded here so a
 * contract change is a change to this file only. Validation is deliberately
 * shallow: we check the fields we read and pass everything else through.
 *
 * Auth is `Authorization: Bearer <Amplify API key>` plus `X-Console-Org-Id`;
 * every Amplify API route needs both.
 *
 * Listing the key's organizations is the one call made before an org is known;
 * it goes to the Amplify account service (`GET /v1.1/user/memberships`, header
 * `X-Amplify-Api-Key`).
 */
import type { Config } from "./config.ts"

export const AGENT_NAME = "detections-runner"

export interface Project {
    id: string
}

export interface Organization {
    id: string
    name: string
}

export type RunStatus = "pending" | "running" | "completed" | "error" | "cancelled" | "skipped"
/** Mirrors the server's terminal set; a status missing here would be polled until the deadline. */
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "error", "cancelled", "skipped"])

export interface Run {
    id: string
    status: RunStatus
}

/** A finding row as served by GET /api/findings. `raw` is the SARIF-shaped payload. */
export interface Finding {
    id: string
    detectionId: string | null
    filePath: string
    raw: unknown
}

export interface SubmitRunInput {
    projectId: string
    baseSha: string
    diff: string
}

export class ApiError extends Error {
    constructor(
        public status: number,
        public code: string | undefined,
        message: string
    ) {
        super(message)
        this.name = "ApiError"
    }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** Client-side bound for a normal request, well under the 1800s hook timeout. */
const REQUEST_TIMEOUT_MS = 30_000
/** GET /api/runs/:id long-polls server-side for up to 30s; give it headroom over that. */
const POLL_TIMEOUT_MS = 45_000
/** Hard cap on findings pages fetched, in case a misreported total keeps the loop going. */
const MAX_FINDINGS_PAGES = 500

export class AmplifyApi {
    /** `requestTimeoutMs` bounds ordinary requests; the synchronous hook uses a short one so a slow network cannot hold up a commit. */
    constructor(
        private config: Config,
        private fetchImpl: FetchLike = (url, init) => fetch(url, init),
        private requestTimeoutMs: number = REQUEST_TIMEOUT_MS
    ) {}

    /**
     * An abort signal that fires after `timeoutMs`, via a timer we own and clear
     * ourselves. `AbortSignal.timeout()` schedules a timer that keeps running
     * (and keeps the process alive) for the full duration even after the
     * request settles; with dozens of requests in a test run, or a single
     * long-poll, that leaves real timers dangling for up to 45s each.
     */
    private withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        timer.unref?.()
        return run(controller.signal).finally(() => clearTimeout(timer))
    }

    private request(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}, timeoutMs = this.requestTimeoutMs) {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: "application/json",
            ...extraHeaders,
        }
        if (this.config.orgId) headers["X-Console-Org-Id"] = this.config.orgId
        if (body !== undefined) headers["Content-Type"] = "application/json"
        return this.withTimeout(timeoutMs, async (signal) => {
            const response = await this.fetchImpl(`${this.config.apiUrl}${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal,
            })
            if (!response.ok) throw await toApiError(response)
            return response.json() as Promise<unknown>
        })
    }

    /** Organizations the API key's user belongs to, from the account service; needs no org. */
    async listMemberships(): Promise<Organization[]> {
        const response = await this.withTimeout(this.requestTimeoutMs, (signal) =>
            this.fetchImpl(`${this.config.tenantUrl}/v1.1/user/memberships`, {
                method: "GET",
                headers: { "X-Amplify-Api-Key": this.config.apiKey, Accept: "application/json" },
                signal,
            })
        )
        if (!response.ok) throw await toApiError(response)
        const data: unknown = await response.json()
        if (!isRecord(data) || !Array.isArray(data.data)) throw new ApiError(200, undefined, "unexpected memberships shape")
        const orgs: Organization[] = []
        for (const row of data.data) {
            const org = isRecord(row) && isRecord(row.organization) ? row.organization : null
            if (org && typeof org.id === "string") orgs.push({ id: org.id, name: typeof org.name === "string" ? org.name : org.id })
        }
        return orgs
    }

    /** Use this organization for every subsequent request. */
    withOrg(orgId: string): AmplifyApi {
        return new AmplifyApi({ ...this.config, orgId }, this.fetchImpl, this.requestTimeoutMs)
    }

    /** Resolve the Amplify project for a repo clone URL; null when the repo is not onboarded. */
    async findProject(repoUrl: string): Promise<Project | null> {
        const data = await this.request("GET", `/api/projects?repoUrl=${encodeURIComponent(repoUrl)}`)
        if (!Array.isArray(data) || data.length === 0) return null
        const first: unknown = data[0]
        if (!isRecord(first) || typeof first.id !== "string") throw new ApiError(200, undefined, "unexpected project shape")
        return { id: first.id }
    }

    /**
     * Submit a detections run against a WIP diff. Always 202 with a run id.
     * Duplicate submissions collapse server-side (identity is derived from the
     * request), so a concurrent re-fire returns the existing run.
     */
    async submitRun(input: SubmitRunInput): Promise<Run> {
        const data = await this.request("POST", "/api/runs", {
            agentName: AGENT_NAME,
            projectId: input.projectId,
            source: { baseSha: input.baseSha, diff: input.diff },
        })
        if (!isRecord(data) || typeof data.runId !== "string") throw new ApiError(202, undefined, "unexpected run shape")
        return { id: data.runId, status: statusOf(data) }
    }

    /** Long-poll a run: the server holds the request (at most 30s) until terminal or `waitSeconds` elapse. */
    async getRun(runId: string, waitSeconds: number): Promise<Run> {
        const data = await this.request("GET", `/api/runs/${encodeURIComponent(runId)}?wait=${waitSeconds}`, undefined, {}, POLL_TIMEOUT_MS)
        if (!isRecord(data) || typeof data.status !== "string") throw new ApiError(200, undefined, "unexpected run shape")
        // The response also carries `error`, the server's failure text. It is not read: it can name
        // infrastructure, and nothing the plugin writes (notice or log) may repeat text a server sent.
        return { id: runId, status: statusOf(data) }
    }

    async listFindings(runId: string): Promise<Finding[]> {
        const findings: Finding[] = []
        const limit = 100
        for (let offset = 0, page = 0; ; offset += limit, page++) {
            if (page >= MAX_FINDINGS_PAGES) throw new ApiError(200, undefined, `findings pagination did not terminate after ${MAX_FINDINGS_PAGES} pages`)
            const data = await this.request(
                "GET",
                `/api/findings?agentRunId=${encodeURIComponent(runId)}&limit=${limit}&offset=${offset}`
            )
            if (!isRecord(data) || !Array.isArray(data.data)) throw new ApiError(200, undefined, "unexpected findings shape")
            for (const row of data.data) {
                if (!isRecord(row) || typeof row.id !== "string") continue
                findings.push({
                    id: row.id,
                    detectionId: typeof row.detectionId === "string" ? row.detectionId : null,
                    filePath: typeof row.filePath === "string" ? row.filePath : "",
                    raw: row.raw,
                })
            }
            const total = typeof data.total === "number" ? data.total : findings.length
            if (data.data.length < limit || findings.length >= total) return findings
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function statusOf(data: Record<string, unknown>): RunStatus {
    return typeof data.status === "string" ? (data.status as RunStatus) : "pending"
}

async function toApiError(response: Response): Promise<ApiError> {
    let code: string | undefined
    let message = `${response.status} ${response.statusText}`
    try {
        const body: unknown = await response.json()
        if (isRecord(body)) {
            if (typeof body.error === "string") code = body.error
            if (typeof body.message === "string") message = body.message
        }
    } catch {
        // Non-JSON error body: keep the status line.
    }
    return new ApiError(response.status, code, message)
}
