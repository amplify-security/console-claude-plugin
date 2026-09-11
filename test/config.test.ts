import { describe, expect, test } from "bun:test"
import { DEFAULT_API_URL, DEFAULT_TENANT_URL, describeMissingConfig, loadConfig } from "../src/config.ts"

describe("loadConfig", () => {
    test("prefers plugin userConfig variables and strips trailing slashes", () => {
        const result = loadConfig({
            CLAUDE_PLUGIN_OPTION_API_KEY: "k1",
            AMPLIFY_API_KEY: "k2",
            CLAUDE_PLUGIN_OPTION_ORG_ID: "org_1",
            CLAUDE_PLUGIN_OPTION_API_URL: "https://api.example.com///",
        })
        expect(result).toEqual({
            ok: true,
            config: { apiKey: "k1", orgId: "org_1", apiUrl: "https://api.example.com", tenantUrl: DEFAULT_TENANT_URL, cadence: "commit" },
        })
    })

    test("falls back to AMPLIFY_* variables", () => {
        const result = loadConfig({ AMPLIFY_API_KEY: "k", AMPLIFY_ORG_ID: "o", AMPLIFY_API_URL: "https://x" })
        expect(result.ok).toBe(true)
    })

    test("only the API key is required; org_id is optional and api_url defaults to production", () => {
        const result = loadConfig({ AMPLIFY_API_KEY: "  " })
        expect(result).toEqual({ ok: false, missing: ["api_key"] })
        if (!result.ok) expect(describeMissingConfig(result.missing)).toContain("AMPLIFY_API_KEY")
        const keyOnly = loadConfig({ AMPLIFY_API_KEY: "k" })
        expect(keyOnly).toEqual({
            ok: true,
            config: { apiKey: "k", orgId: "", apiUrl: DEFAULT_API_URL, tenantUrl: DEFAULT_TENANT_URL, cadence: "commit" },
        })
        expect(DEFAULT_API_URL).toBe("https://agent.console.prod.amplify.security")
        expect(DEFAULT_TENANT_URL).toBe("https://tenant.console.prod.amplify.security")
        expect(loadConfig({ AMPLIFY_API_KEY: "k", AMPLIFY_TENANT_PROVISIONER_URL: "https://t/" })).toMatchObject({ config: { tenantUrl: "https://t" } })
    })
})
