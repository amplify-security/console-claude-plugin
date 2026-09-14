import { describe, expect, test } from "bun:test"
import type { Finding } from "../src/amplify-api.ts"
import { filterToScope, formatContext, formatSummary, MAX_CONTEXT_FINDINGS, parseFinding } from "../src/findings.ts"

const sarif = (over: Record<string, unknown> = {}): Finding => ({
    id: "f1",
    detectionId: "det_1",
    filePath: "src/db.ts",
    raw: {
        ruleId: "sql-injection",
        level: "warning",
        message: { text: "User input reaches a\n   raw SQL query." },
        locations: [{ physicalLocation: { artifactLocation: { uri: "src/db.ts" }, region: { startLine: 42 } } }],
        properties: { severity: "high", category: "injection" },
        ...over,
    },
})

describe("parseFinding", () => {
    test("reads location, severity, rule and message from SARIF", () => {
        expect(parseFinding(sarif())).toEqual({
            id: "f1",
            file: "src/db.ts",
            line: 42,
            endLine: 42,
            severity: "high",
            rule: "sql-injection",
            category: "injection",
            message: "User input reaches a\n   raw SQL query.",
        })
    })

    test("falls back to SARIF level, filePath and detectionId when fields are missing", () => {
        const parsed = parseFinding({ id: "f2", detectionId: "det_2", filePath: "a.ts", raw: { level: "error", message: {} } })
        expect(parsed).toMatchObject({ file: "a.ts", line: null, severity: "high", rule: "det_2", message: "(no description)" })
        expect(parseFinding({ id: "f3", detectionId: null, filePath: "b.ts", raw: null }).severity).toBe("info")
    })
})

describe("filterToScope", () => {
    const f = parseFinding(sarif())
    test("keeps findings on added lines and drops the rest", () => {
        expect(filterToScope([f], new Map([["src/db.ts", new Set([42])]]))).toHaveLength(1)
        expect(filterToScope([f], new Map([["src/db.ts", new Set([41])]]))).toHaveLength(0)
        expect(filterToScope([f], new Map([["other.ts", new Set([42])]]))).toHaveLength(0)
    })
    test("matches over the finding's span and tolerates ./ prefixes, like the server", () => {
        const span = parseFinding(sarif({ locations: [{ physicalLocation: { artifactLocation: { uri: "./src/db.ts" }, region: { startLine: 40, endLine: 45 } } }] }))
        expect(span.file).toBe("src/db.ts")
        expect(span.endLine).toBe(45)
        expect(filterToScope([span], new Map([["src/db.ts", new Set([44])]]))).toHaveLength(1)
        expect(filterToScope([span], new Map([["src/db.ts", new Set([46])]]))).toHaveLength(0)
    })
    test("keeps line-less findings when the file changed, everything when scope is unknown, and nothing when no lines were added", () => {
        const noLine = { ...f, line: null }
        expect(filterToScope([noLine], new Map([["src/db.ts", new Set([1])]]))).toHaveLength(1)
        expect(filterToScope([f], null)).toHaveLength(1)
        expect(filterToScope([f], new Map())).toHaveLength(0)
    })
})

describe("formatting", () => {
    const findings = [parseFinding(sarif()), parseFinding(sarif({ properties: { severity: "critical" }, ruleId: "secrets" }))]
    test("summary counts by severity, highest first", () => {
        expect(formatSummary(findings)).toBe("Amplify Console: 1 critical, 1 high in 1 file")
    })
    test("context carries provenance, triage framing, and sorted findings", () => {
        const text = formatContext(findings, { commitSha: "abcdef1234567890", runId: "run_1" })
        expect(text).toContain("not user input")
        expect(text).toContain("NOT confirmed")
        expect(text.indexOf("[CRITICAL] secrets")).toBeLessThan(text.indexOf("[HIGH] sql-injection (injection)"))
        expect(text).toContain("src/db.ts:42")
        expect(text).toContain("User input reaches a raw SQL query.")
    })
    test("caps the listed findings and summarizes the rest in one line", () => {
        const many = Array.from({ length: MAX_CONTEXT_FINDINGS + 3 }, (_, i) => parseFinding(sarif({ ruleId: `rule-${i}` })))
        const text = formatContext(many, { commitSha: "abcdef1234567890", runId: "run_1" })
        expect(text).toContain(`reported ${many.length} findings`)
        expect(text).toContain(`... and 3 more.`)
        expect(text).not.toContain(`rule-${MAX_CONTEXT_FINDINGS}`)
        expect(text).toContain(`rule-${MAX_CONTEXT_FINDINGS - 1}`)
    })
})
