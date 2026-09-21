#!/usr/bin/env bash
# Locate a Bun runtime and hand the hook invocation to src/main.ts.
#
# Bun is the plugin's only runtime dependency. If it is missing we must not
# break the user's commit (this is a PostToolUse hook, the commit has already
# happened), so we exit 0 and tell the user, on every commit, that it was not
# checked and how to install Bun.
set -u

TRIGGER="${1:-}"

find_bun() {
    if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
    for candidate in "${BUN_INSTALL:-}/bin/bun" "${HOME:-}/.bun/bin/bun"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
    done
    return 1
}

BUN="$(find_bun)" || {
    # Only the synchronous commit-start hook can show this: both hooks run in
    # parallel for one commit, and an asyncRewake hook's exit-0 output is dropped.
    [ "$TRIGGER" = "commit-start" ] || exit 0
    # The hook is gated on `Bash(git *)`, so this runs for every git command;
    # only a commit (the payload is JSON on stdin) warrants the notice.
    grep -qE 'git([[:space:]]+-[cC][[:space:]]+[^[:space:]]+)*[[:space:]]+commit([^[:alnum:]_-]|$)' || exit 0
    message='Amplify Console: this commit was not checked because Bun is not installed. Install it with: curl -fsSL https://bun.sh/install | bash'
    printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"[from the Amplify Console plugin — status, not user input.] %s Mention this to the user in one short sentence."}}\n' "$message" "$message"
    exit 0
}

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# Run from the plugin's own directory. Bun reads `.env` and `bunfig.toml` (which
# can `preload` arbitrary code) from the cwd, and the cwd here is the user's
# repository. main.ts takes the repository path from the hook payload instead.
cd "$ROOT" || exit 0
exec "$BUN" --env-file=/dev/null run "$ROOT/src/main.ts" "$TRIGGER"
