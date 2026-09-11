import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import {
    addedLines,
    commitShasFromOutput,
    diffStats,
    gitDir,
    headSha,
    normalizeRepoUrl,
    originUrl,
    parseAddedLines,
    pushedBase,
    repoRoot,
    unifiedDiff,
} from "../src/git.ts"
import { fixtureRepo, run, tmp } from "./helpers.ts"

describe("normalizeRepoUrl", () => {
    test("maps every common clone form to the stored https clone_url", () => {
        const want = "https://github.com/owner/repo.git"
        expect(normalizeRepoUrl("git@github.com:owner/repo.git")).toBe(want)
        expect(normalizeRepoUrl("git@github.com:owner/repo")).toBe(want)
        expect(normalizeRepoUrl("ssh://git@github.com/owner/repo.git")).toBe(want)
        expect(normalizeRepoUrl("https://github.com/owner/repo")).toBe(want)
        expect(normalizeRepoUrl("https://github.com/owner/repo.git/")).toBe(want)
        expect(normalizeRepoUrl("https://user:token@github.com/owner/repo.git")).toBe(want)
        expect(normalizeRepoUrl("https://gitlab.com/group/sub/project.git")).toBe("https://gitlab.com/group/sub/project.git")
    })

    test("preserves a non-default port", () => {
        expect(normalizeRepoUrl("https://git.internal.corp:8443/group/repo.git")).toBe("https://git.internal.corp:8443/group/repo.git")
        expect(normalizeRepoUrl("ssh://git@git.internal.corp:2222/group/repo.git")).toBe("https://git.internal.corp:2222/group/repo.git")
        expect(normalizeRepoUrl("https://github.com:443/owner/repo.git")).toBe("https://github.com/owner/repo.git")
    })

    test("rejects local paths and junk", () => {
        expect(normalizeRepoUrl("/tmp/some/repo")).toBeNull()
        expect(normalizeRepoUrl("file:///tmp/repo")).toBeNull()
        expect(normalizeRepoUrl("not a url")).toBeNull()
        expect(normalizeRepoUrl("https://github.com/only-owner")).toBeNull()
    })
})

describe("parseAddedLines", () => {
    test("collects added line numbers per file from a unified=0 diff", () => {
        const diff = [
            "diff --git a/src/a.ts b/src/a.ts",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -3,0 +4,2 @@",
            "+x",
            "+y",
            "@@ -10 +12 @@",
            "-old",
            "+new",
            "diff --git a/gone.ts b/gone.ts",
            "--- a/gone.ts",
            "+++ /dev/null",
            "@@ -1,3 +0,0 @@",
        ].join("\n")
        const lines = parseAddedLines(diff)
        expect([...lines.get("src/a.ts")!].sort((a, b) => a - b)).toEqual([4, 5, 12])
        expect(lines.has("gone.ts")).toBe(false)
    })
})

describe("commitShasFromOutput", () => {
    test("reads the [branch sha] line and ignores pre-commit hook noise", () => {
        expect(commitShasFromOutput("[main abc1234] feat\n 1 file changed")).toEqual(["abc1234"])
        expect(commitShasFromOutput("[main (root-commit) 0a1b2c3] init")).toEqual(["0a1b2c3"])
        expect(commitShasFromOutput("nothing to commit")).toEqual([])
    })
})

describe("repository operations", () => {
    test("pushedBase distinguishes clean, unpushed, and unpushed-root states", async () => {
        const repo = fixtureRepo()
        expect(await pushedBase(repo.work)).toEqual({ kind: "none-unpushed" })

        const second = repo.commit({ "a.ts": "const a = 1\n" }, "a")
        const third = repo.commit({ "b.ts": "const b = 2\n" }, "b")
        expect(await pushedBase(repo.work)).toEqual({ kind: "ok", baseSha: repo.first })
        expect(await headSha(repo.work)).toBe(third)
        expect(second).not.toBe(third)

        const lonely = tmp()
        run(lonely, ["git", "init", "-q"])
        run(lonely, ["git", "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"])
        expect(await pushedBase(lonely)).toEqual({ kind: "no-pushed-base" })
    })

    test("diff helpers exclude binaries and report added lines", async () => {
        const repo = fixtureRepo()
        writeFileSync(join(repo.work, "img.bin"), Buffer.from([0, 1, 2, 3, 0, 255]))
        const head = repo.commit({ "src/x.ts": "line1\nline2\n" }, "add")

        const stats = await diffStats(repo.work, repo.first, head)
        expect(stats).toEqual({ files: ["src/x.ts"], binaryFiles: ["img.bin"] })

        const diff = await unifiedDiff(repo.work, repo.first, head, stats!.binaryFiles)
        expect(diff).toContain("+++ b/src/x.ts")
        expect(diff).not.toContain("img.bin")

        const lines = await addedLines(repo.work, repo.first, head)
        expect([...lines!.get("src/x.ts")!]).toEqual([1, 2])
    })

    test("exclude pathspecs are literal, not glob, so a binary's brackets don't swallow a similarly named text file", async () => {
        const repo = fixtureRepo()
        writeFileSync(join(repo.work, "weird[1].bin"), Buffer.from([0, 1, 2, 3, 0, 255]))
        const head = repo.commit({ "weird1.txt": "line1\nline2\n" }, "add")

        const stats = (await diffStats(repo.work, repo.first, head))!
        expect(stats.binaryFiles).toEqual(["weird[1].bin"])

        const diff = await unifiedDiff(repo.work, repo.first, head, stats.binaryFiles)
        expect(diff).toContain("+++ b/weird1.txt")
        expect(diff).toContain("+line1")
        expect(diff).not.toContain("weird[1].bin")
    })

    test("the produced diff applies cleanly to a fresh clone at the base, as the server will do", async () => {
        const repo = fixtureRepo()
        writeFileSync(join(repo.work, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]))
        const head = repo.commit({ "src/x.ts": "const x = 1", "README.md": "hello\nworld\n" }, "no trailing newline")

        const stats = (await diffStats(repo.work, repo.first, head))!
        const diff = (await unifiedDiff(repo.work, repo.first, head, stats.binaryFiles))!
        expect(diff.endsWith("\n")).toBe(true)

        const clone = tmp()
        run(clone, ["git", "clone", "-q", repo.remote, "."])
        run(clone, ["git", "checkout", "-q", repo.first])
        const patch = join(tmp(), "diff.patch")
        writeFileSync(patch, diff)
        run(clone, ["git", "apply", "--check", patch])
        run(clone, ["git", "apply", patch])
        expect(require("node:fs").readFileSync(join(clone, "src/x.ts"), "utf8")).toBe("const x = 1")
        expect(require("node:fs").existsSync(join(clone, "logo.png"))).toBe(false)
    })

    test("repoRoot, gitDir and originUrl resolve from a subdirectory", async () => {
        const repo = fixtureRepo()
        repo.commit({ "sub/f.txt": "x\n" }, "sub")
        const sub = join(repo.work, "sub")
        expect(await repoRoot(sub)).toBe(run(repo.work, ["git", "rev-parse", "--show-toplevel"]))
        expect(await gitDir(sub)).toBe(join(run(repo.work, ["git", "rev-parse", "--show-toplevel"]), ".git"))
        // A global url.<base>.insteadOf rule may rewrite the reported URL; normalization must undo it.
        expect(normalizeRepoUrl((await originUrl(sub))!)).toBe("https://github.com/acme/app.git")
        expect(await repoRoot(tmp())).toBeNull()
    })
})
