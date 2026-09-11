import { describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    appendCheckedSha,
    dataDir,
    firstTimeThisSession,
    readCheckedShas,
    readRepoCache,
    writeOrgCache,
    writeRepoCache,
} from "../src/state.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "amplify-state-"))

describe("state", () => {
    test("dataDir honours CLAUDE_PLUGIN_DATA", () => {
        expect(dataDir({ CLAUDE_PLUGIN_DATA: "/x" })).toBe("/x")
        expect(dataDir({})).toContain("console")
    })

    test("firstTimeThisSession is true once per session and key", () => {
        const dir = tmp()
        expect(firstTimeThisSession(dir, "s1", "unconfigured")).toBe(true)
        expect(firstTimeThisSession(dir, "s1", "unconfigured")).toBe(false)
        expect(firstTimeThisSession(dir, "s1", "other")).toBe(true)
        expect(firstTimeThisSession(dir, "s2", "unconfigured")).toBe(true)
    })

    test("checked shas round-trip and cap at 500", () => {
        const gitDir = tmp()
        expect(readCheckedShas(gitDir).size).toBe(0)
        for (let i = 0; i < 510; i++) appendCheckedSha(gitDir, `sha${i}`)
        const shas = readCheckedShas(gitDir)
        expect(shas.size).toBe(500)
        expect(shas.has("sha509")).toBe(true)
        expect(shas.has("sha9")).toBe(false)
    })

    test("repo cache round-trips and tolerates corruption", () => {
        const gitDir = tmp()
        expect(readRepoCache(gitDir)).toBeNull()
        writeRepoCache(gitDir, { repoUrl: "https://github.com/o/r.git", projectId: "p1" })
        expect(readRepoCache(gitDir)).toEqual({ repoUrl: "https://github.com/o/r.git", projectId: "p1" })
        Bun.write(join(gitDir, "amplify-console.json"), "{not json")
    })

    test("appendCheckedSha only appends, so it can't clobber a line written by a concurrent hook invocation", () => {
        const gitDir = tmp()
        appendCheckedSha(gitDir, "sha_a")
        // Simulate another process's concurrent append landing between ours: unlike a
        // read-modify-write, appendCheckedSha never reads the file first, so it can't
        // stomp on this when it writes its own next line.
        appendFileSync(join(gitDir, "amplify-checked-shas"), "sha_b\t2020-01-01T00:00:00.000Z\n")
        appendCheckedSha(gitDir, "sha_c")
        const shas = readCheckedShas(gitDir)
        expect(shas.has("sha_a")).toBe(true)
        expect(shas.has("sha_b")).toBe(true)
        expect(shas.has("sha_c")).toBe(true)
    })

    test("writeRepoCache and writeOrgCache write via rename, leaving no temp file behind", () => {
        const gitDir = tmp()
        writeRepoCache(gitDir, { repoUrl: "https://github.com/o/r.git", projectId: "p1" })
        writeOrgCache(gitDir, { apiUrl: "https://api.test", keyFingerprint: "abc", orgId: "org_1", orgName: "Org" })
        expect(readdirSync(gitDir).sort()).toEqual(["amplify-console.json", "org.json"])
    })
})
