/**
 * Claude Code hook I/O contract.
 *
 * Input: one JSON object on stdin. Output: at most one JSON line on stdout.
 * For an asyncRewake PostToolUse hook, model-visible text travels in
 * `hookSpecificOutput.additionalContext`, the user-visible one-liner in
 * `rewakeSummary`, and exiting with code 2 after emitting is what wakes the
 * model. Exiting 0 means "nothing to report". A synchronous PostToolUse hook
 * is read on exit 0 instead: its `additionalContext` is appended to the tool
 * result and its `systemMessage` shown to the user.
 */

export interface HookInput {
    session_id: string
    cwd: string
    hook_event_name: string
    tool_name?: string
    tool_input?: Record<string, unknown>
    tool_response?: Record<string, unknown>
}

export interface HookOutput {
    /** Model-visible text delivered on the rewake turn. */
    additionalContext?: string
    /** User-visible one-liner shown as the task notification. */
    rewakeSummary?: string
    /** User-visible message in the terminal, independent of a rewake. */
    systemMessage?: string
}

export const EXIT_OK = 0
export const EXIT_REWAKE = 2

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseHookInput(raw: string): HookInput {
    const data: unknown = JSON.parse(raw)
    if (!isRecord(data)) throw new Error("hook input is not a JSON object")
    if (typeof data.session_id !== "string" || typeof data.cwd !== "string") {
        throw new Error("hook input is missing session_id or cwd")
    }
    return {
        session_id: data.session_id,
        cwd: data.cwd,
        hook_event_name: typeof data.hook_event_name === "string" ? data.hook_event_name : "",
        tool_name: typeof data.tool_name === "string" ? data.tool_name : undefined,
        tool_input: isRecord(data.tool_input) ? data.tool_input : undefined,
        tool_response: isRecord(data.tool_response) ? data.tool_response : undefined,
    }
}

export async function readHookInput(): Promise<HookInput> {
    return parseHookInput(await Bun.stdin.text())
}

export function formatHookOutput(out: HookOutput): string {
    const json: Record<string, unknown> = {}
    if (out.rewakeSummary) json.rewakeSummary = out.rewakeSummary
    if (out.systemMessage) json.systemMessage = out.systemMessage
    if (out.additionalContext) {
        json.hookSpecificOutput = { hookEventName: "PostToolUse", additionalContext: out.additionalContext }
    }
    return JSON.stringify(json)
}

export function emit(out: HookOutput): void {
    process.stdout.write(formatHookOutput(out) + "\n")
}
