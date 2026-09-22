import { describe, expect, test } from "bun:test"
import { AmplifyApi, ApiError } from "../src/amplify-api.ts"

const config = { apiKey: "key", orgId: "org_1", apiUrl: "https://api.test", tenantUrl: "https://tenant.test", cadence: "commit" }

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return handler(url, init)
    }
    return { calls, api: new AmplifyApi(config, fetchImpl) }
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

describe("AmplifyApi", () => {
    test("sends the bearer key and org header on every request", async () => {
        const { calls, api } = fakeFetch(() => json([]))
        await api.findProject("https://github.com/o/r.git")
        const headers = calls[0]!.init.headers as Record<string, string>
        expect(headers.Authorization).toBe("Bearer key")
        expect(headers["X-Console-Org-Id"]).toBe("org_1")
        expect(calls[0]!.url).toBe("https://api.test/api/projects?repoUrl=https%3A%2F%2Fgithub.com%2Fo%2Fr.git")
        expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
    })

    test("findProject returns null for an unknown repo and the id otherwise", async () => {
        expect(await fakeFetch(() => json([])).api.findProject("u")).toBeNull()
        expect(await fakeFetch(() => json([{ id: "p1", name: "r" }])).api.findProject("u")).toEqual({ id: "p1" })
    })

    test("submitRun posts the diff source and reads the returned status", async () => {
        const { calls, api } = fakeFetch(() => json({ runId: "run_1", status: "running", deduped: true }, 202))
        const run = await api.submitRun({ projectId: "p1", baseSha: "abc", diff: "diff --git" })
        expect(run).toEqual({ id: "run_1", status: "running" })
        expect(calls[0]!.url).toBe("https://api.test/api/runs")
        expect(calls[0]!.init.method).toBe("POST")
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            agentName: "detections-runner",
            projectId: "p1",
            source: { baseSha: "abc", diff: "diff --git" },
        })
        expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined()
    })

    test("getRun long-polls with the wait parameter", async () => {
        const { calls, api } = fakeFetch(() => json({ id: "run_1", status: "error", error: "git apply failed" }))
        // The server's error text is deliberately not read: nothing the plugin writes may repeat it.
        expect(await api.getRun("run_1", 30)).toEqual({ id: "run_1", status: "error" })
        expect(calls[0]!.url).toBe("https://api.test/api/runs/run_1?wait=30")
        // A hung connection must not tie up the run indefinitely: bounded by a client-side abort, longer than the server's poll wait.
        expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
    })

    test("listFindings pages through results", async () => {
        const page = (n: number, total: number) => ({
            data: Array.from({ length: n }, (_, i) => ({ id: `f${i}`, detectionId: "d", filePath: "a.ts", raw: {} })),
            total,
            limit: 100,
            offset: 0,
        })
        let call = 0
        const { calls, api } = fakeFetch(() => json(call++ === 0 ? page(100, 150) : page(50, 150)))
        const findings = await api.listFindings("run_1")
        expect(findings).toHaveLength(150)
        expect(calls[0]!.url).toContain("agentRunId=run_1&limit=100&offset=0")
        expect(calls[1]!.url).toContain("offset=100")
    })

    test("listFindings gives up after a hard cap of pages rather than looping forever on a misreported total", async () => {
        const page = () => ({
            data: Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, detectionId: "d", filePath: "a.ts", raw: {} })),
            total: Number.MAX_SAFE_INTEGER,
            limit: 100,
            offset: 0,
        })
        const { api } = fakeFetch(() => json(page()))
        const err = await api.listFindings("run_1").catch((e: unknown) => e)
        expect(err).toBeInstanceOf(ApiError)
        expect((err as ApiError).message).toContain("pages")
    })

    test("lists memberships from the account service with the API key header only", async () => {
        const { calls, api } = fakeFetch(() =>
            json({ data: [{ id: "m1", organization: { id: "org_a", name: "Acme" } }, { id: "m2", organization: { id: "org_b", name: "Beta" } }], total_count: 2 })
        )
        const noOrg = new AmplifyApi({ ...config, orgId: "" }, (url, init) => api["fetchImpl"](url, init))
        expect(await noOrg.listMemberships()).toEqual([{ id: "org_a", name: "Acme" }, { id: "org_b", name: "Beta" }])
        expect(calls[0]!.url).toBe("https://tenant.test/v1.1/user/memberships")
        const headers = calls[0]!.init.headers as Record<string, string>
        expect(headers["X-Amplify-Api-Key"]).toBe("key")
        expect(headers.Authorization).toBeUndefined()
        expect(headers["X-Console-Org-Id"]).toBeUndefined()
        expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)

        await noOrg.withOrg("org_b").findProject("u").catch(() => null)
        expect((calls[1]!.init.headers as Record<string, string>)["X-Console-Org-Id"]).toBe("org_b")
    })

    test("surfaces the service error envelope", async () => {
        const { api } = fakeFetch(() => json({ error: "FORBIDDEN", message: "nope" }, 403))
        const err = await api.getRun("x", 1).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(ApiError)
        expect((err as ApiError).status).toBe(403)
        expect((err as ApiError).code).toBe("FORBIDDEN")
        expect((err as ApiError).message).toBe("nope")
    })
})
