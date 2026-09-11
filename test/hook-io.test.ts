import { describe, expect, test } from "bun:test"
import { formatHookOutput, parseHookInput } from "../src/hook-io.ts"

describe("parseHookInput", () => {
    test("extracts the fields the commit hook needs", () => {
        const input = parseHookInput(
            JSON.stringify({
                session_id: "s1",
                cwd: "/repo",
                hook_event_name: "PostToolUse",
                tool_name: "Bash",
                tool_input: { command: "git commit -m x" },
                tool_response: { stdout: "[main abc1234] x\n 1 file changed" },
            })
        )
        expect(input.session_id).toBe("s1")
        expect(input.cwd).toBe("/repo")
        expect(input.tool_input?.command).toBe("git commit -m x")
        expect(input.tool_response?.stdout).toContain("abc1234")
    })

    test("rejects input without session_id or cwd", () => {
        expect(() => parseHookInput(JSON.stringify({ cwd: "/repo" }))).toThrow()
        expect(() => parseHookInput("[]")).toThrow()
    })

    test("drops non-object tool_input and tool_response", () => {
        const input = parseHookInput(JSON.stringify({ session_id: "s", cwd: "/", tool_input: "x", tool_response: 3 }))
        expect(input.tool_input).toBeUndefined()
        expect(input.tool_response).toBeUndefined()
    })
})

describe("formatHookOutput", () => {
    test("puts model text under hookSpecificOutput for PostToolUse", () => {
        const json = JSON.parse(formatHookOutput({ additionalContext: "fix it", rewakeSummary: "1 issue" }))
        expect(json).toEqual({
            rewakeSummary: "1 issue",
            hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "fix it" },
        })
    })

    test("omits empty fields", () => {
        expect(JSON.parse(formatHookOutput({ systemMessage: "hi" }))).toEqual({ systemMessage: "hi" })
        expect(JSON.parse(formatHookOutput({}))).toEqual({})
    })
})
