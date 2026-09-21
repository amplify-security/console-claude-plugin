/**
 * Plugin configuration.
 *
 * Values come from the plugin's `userConfig` (exported by Claude Code as
 * CLAUDE_PLUGIN_OPTION_<KEY>), with plain AMPLIFY_* environment variables as
 * a fallback for users who prefer shell configuration. Missing required values
 * are reported, not thrown: a PostToolUse hook that fails every commit would
 * be hostile, so the caller tells the user the commit was not checked and why.
 */

export interface Config {
    apiKey: string
    /** Empty when not configured: resolved from the key's memberships at run time. */
    orgId: string
    apiUrl: string
    /** Amplify account service base URL; only used to list the key's organizations. */
    tenantUrl: string
    cadence: string
}

/** `problem` is the user-facing reason no check can run, phrased to follow "commit X was not checked." */
export type ConfigResult = { ok: true; config: Config } | { ok: false; problem: string }

const CADENCES = ["commit"]

type Env = Record<string, string | undefined>

export const DEFAULT_API_URL = "https://agent.console.prod.amplify.security"
export const DEFAULT_TENANT_URL = "https://tenant.console.prod.amplify.security"

const SOURCES: Record<keyof Config, { setting: string; env: string[] }> = {
    apiKey: { setting: "api_key", env: ["CLAUDE_PLUGIN_OPTION_API_KEY", "AMPLIFY_API_KEY"] },
    orgId: { setting: "org_id", env: ["CLAUDE_PLUGIN_OPTION_ORG_ID", "AMPLIFY_ORG_ID"] },
    apiUrl: { setting: "api_url", env: ["CLAUDE_PLUGIN_OPTION_API_URL", "AMPLIFY_API_URL"] },
    tenantUrl: { setting: "tenant_url", env: ["CLAUDE_PLUGIN_OPTION_TENANT_URL", "AMPLIFY_TENANT_PROVISIONER_URL"] },
    cadence: { setting: "cadence", env: ["CLAUDE_PLUGIN_OPTION_CADENCE", "AMPLIFY_CADENCE"] },
}

function firstSet(env: Env, names: string[]): string | undefined {
    for (const name of names) {
        const value = env[name]?.trim()
        if (value) return value
    }
    return undefined
}

export function loadConfig(env: Env = process.env): ConfigResult {
    const apiKey = firstSet(env, SOURCES.apiKey.env)
    const orgId = firstSet(env, SOURCES.orgId.env)
    const apiUrl = firstSet(env, SOURCES.apiUrl.env) ?? DEFAULT_API_URL
    const tenantUrl = firstSet(env, SOURCES.tenantUrl.env) ?? DEFAULT_TENANT_URL
    const cadence = firstSet(env, SOURCES.cadence.env) ?? "commit"

    const missing: string[] = []
    if (!apiKey) missing.push(SOURCES.apiKey.setting)
    if (missing.length > 0) return { ok: false, problem: describeMissingConfig(missing) }
    if (!CADENCES.includes(cadence)) {
        return {
            ok: false,
            problem:
                `The plugin's cadence is set to "${cadence}", but only ${CADENCES.map((c) => `"${c}"`).join(", ")} is supported. ` +
                `Fix it in /plugin configure console@amplify-security or unset AMPLIFY_CADENCE, then start a new Claude Code session.`,
        }
    }

    return {
        ok: true,
        config: {
            apiKey: apiKey!,
            orgId: orgId ?? "",
            apiUrl: apiUrl.replace(/\/+$/, ""),
            tenantUrl: tenantUrl.replace(/\/+$/, ""),
            cadence,
        },
    }
}

export function describeMissingConfig(missing: string[]): string {
    return (
        `The plugin is not configured (missing ${missing.join(", ")}). ` +
        `Set ${missing.map((m) => `AMPLIFY_${m.toUpperCase()}`).join(", ")} in the shell that launches Claude Code, or reinstall with \`claude plugin install console@amplify-security --config ${missing.map((m) => `${m}=<value>`).join(" --config ")}\`, then start a new Claude Code session.`
    )
}

/**
 * Dry run: do everything up to the API call, then write the diff and the
 * request that would have been sent to `$CLAUDE_PLUGIN_DATA/dry-run/` instead.
 * Development aid while the runs endpoint is not available.
 */
export function isDryRun(env: Env = process.env): boolean {
    const value = env.AMPLIFY_DRY_RUN?.trim().toLowerCase()
    return value !== undefined && value !== "" && value !== "0" && value !== "false"
}
