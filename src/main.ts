/**
 * Hook entry point. `hooks/run.sh` invokes this as `bun run src/main.ts <trigger>`
 * with the Claude Code hook payload on stdin.
 *
 * An unexpected failure before a check was announced is logged and exits 0: a
 * hook must never make the user's commit look broken, and nothing was promised
 * yet. Once a check is announced, `runCommitCheck` owns the failure and reports it.
 */
import { announceCommitCheck, recordPreCommitHead, runCommitCheck } from "./commit.ts"
import { EXIT_OK, outputFlushed, readHookInput } from "./hook-io.ts"
import { dataDir, log } from "./state.ts"

const trigger = process.argv[2] ?? ""

let exitCode = EXIT_OK
try {
    const input = await readHookInput()
    if (trigger === "commit") {
        exitCode = await runCommitCheck(input)
    } else if (trigger === "commit-start") {
        exitCode = await announceCommitCheck(input)
    } else if (trigger === "commit-pre") {
        exitCode = await recordPreCommitHead(input)
    } else {
        log(dataDir(), `unknown trigger "${trigger}"`)
    }
} catch (err) {
    log(dataDir(), `unhandled error in trigger "${trigger}": ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    exitCode = EXIT_OK
}
await outputFlushed()
process.exit(exitCode)
