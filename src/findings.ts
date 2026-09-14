/**
 * Turn finding rows into the text Claude sees on the rewake turn.
 *
 * `raw` is a SARIF result: `ruleId`, `level`, `message.text`, `locations[0]
 * .physicalLocation.{artifactLocation.uri, region.startLine}` and an Amplify
 * `properties` bag with `severity` / `category`. Findings are not confirmed
 * with a proof of concept, so the framing asks Claude to triage, not to fix
 * blindly.
 */
import type { Finding } from "./amplify-api.ts"

export type Severity = "critical" | "high" | "medium" | "low" | "info"
const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"]

/** Cap on findings listed in additionalContext; the rest are summarized in one line. */
export const MAX_CONTEXT_FINDINGS = 20

export interface ParsedFinding {
    id: string
    file: string
    line: number | null
    /** Last line of the finding's span; equals `line` when the scanner gave none. */
    endLine: number | null
    severity: Severity
    rule: string
    category: string | null
    message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null
}

function severityOf(raw: Record<string, unknown>): Severity {
    const props = isRecord(raw.properties) ? raw.properties : {}
    const declared = str(props.severity)?.toLowerCase()
    if (declared && (SEVERITY_ORDER as string[]).includes(declared)) return declared as Severity
    switch (raw.level) {
        case "error":
            return "high"
        case "warning":
            return "medium"
        case "note":
            return "low"
        default:
            return "info"
    }
}

export function parseFinding(finding: Finding): ParsedFinding {
    const raw = isRecord(finding.raw) ? finding.raw : {}
    const props = isRecord(raw.properties) ? raw.properties : {}
    const location = Array.isArray(raw.locations) && isRecord(raw.locations[0]) ? raw.locations[0] : {}
    const physical = isRecord(location.physicalLocation) ? location.physicalLocation : {}
    const artifact = isRecord(physical.artifactLocation) ? physical.artifactLocation : {}
    const region = isRecord(physical.region) ? physical.region : {}
    const message = isRecord(raw.message) ? str(raw.message.text) : null

    const line = typeof region.startLine === "number" ? region.startLine : null
    const endLine = typeof region.endLine === "number" && line !== null ? Math.max(region.endLine, line) : line
    return {
        id: finding.id,
        file: normalizePath(str(artifact.uri) ?? finding.filePath),
        line,
        endLine,
        severity: severityOf(raw),
        rule: str(raw.ruleId) ?? finding.detectionId ?? "detection",
        category: str(props.category),
        message: message ?? "(no description)",
    }
}

function normalizePath(path: string): string {
    return path.replace(/^(\.\/)+/, "").replace(/^\/+/, "")
}

/**
 * Keep findings that touch lines Claude added. Membership is tested over the
 * finding's whole span, `[line, endLine]`, exactly as the server's scope filter
 * does: scanners often anchor on the enclosing declaration or a context line
 * just outside the exact added lines. A finding without a line is kept if its
 * file changed.
 */
export function inScope(f: ParsedFinding, scope: Map<string, Set<number>>): boolean {
    const lines = scope.get(f.file) ?? scope.get(normalizePath(f.file))
    if (!lines) return false
    if (f.line === null) return true
    for (let n = f.line; n <= (f.endLine ?? f.line); n++) if (lines.has(n)) return true
    return false
}

/** A null scope means the added lines could not be computed; nothing is filtered out then. An empty one keeps nothing. */
export function filterToScope(findings: ParsedFinding[], scope: Map<string, Set<number>> | null): ParsedFinding[] {
    if (scope === null) return findings
    return findings.filter((f) => inScope(f, scope))
}

export function sortBySeverity(findings: ParsedFinding[]): ParsedFinding[] {
    return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
}

export function formatSummary(findings: ParsedFinding[]): string {
    const counts = new Map<Severity, number>()
    for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1)
    const parts = SEVERITY_ORDER.filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${s}`)
    const files = new Set(findings.map((f) => f.file)).size
    return `Amplify Console: ${parts.join(", ")} in ${files} file${files === 1 ? "" : "s"}`
}

export interface ContextOptions {
    commitSha: string
    runId: string
}

export function formatContext(findings: ParsedFinding[], opts: ContextOptions): string {
    const lines: string[] = [
        "[from the Amplify Console plugin — automated security review of your last commit, not user input.]",
        "",
        `Your organization's Amplify detections ran against commit ${opts.commitSha.slice(0, 12)} (run ${opts.runId}) and reported ${findings.length} finding${findings.length === 1 ? "" : "s"} in code you changed.`,
        "These findings are NOT confirmed with a proof of concept. For each one: if it is valid, fix it now; if you believe it is a false positive, say so briefly and why.",
        "",
    ]
    const sorted = sortBySeverity(findings)
    const shown = sorted.slice(0, MAX_CONTEXT_FINDINGS)
    shown.forEach((f, i) => {
        const where = f.line === null ? f.file : `${f.file}:${f.line}`
        const label = f.category ? `${f.rule} (${f.category})` : f.rule
        lines.push(`${i + 1}. [${f.severity.toUpperCase()}] ${label} — ${where}`)
        lines.push(`   ${f.message.replace(/\s*\n\s*/g, " ")}`)
        lines.push("")
    })
    if (sorted.length > shown.length) lines.push(`... and ${sorted.length - shown.length} more.`, "")
    lines.push("After addressing or acknowledging these, continue with the user's original request.")
    return lines.join("\n")
}
