#!/usr/bin/env bash
# Locate a Bun runtime and hand the hook invocation to src/main.ts.
#
# Bun is the plugin's only runtime dependency. If it is missing we must not
# break the user's commit (this is a PostToolUse hook, the commit has already
# happened), so we exit 0 and tell the user how to install it. The reminder is
# rate-limited to once a day via a marker file in the plugin's data directory.
set -u

TRIGGER="${1:-}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-${HOME:-}/.claude/plugins/data/console-amplify-security}"

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
    mkdir -p "$DATA_DIR" 2>/dev/null
    marker="$DATA_DIR/bun-missing-notified"
    if [ -z "$(find "$marker" -mtime -1 2>/dev/null)" ]; then
        touch "$marker" 2>/dev/null
        printf '%s\n' '{"systemMessage":"Amplify Console: Bun is not installed, so detections did not run. Install it with: curl -fsSL https://bun.sh/install | bash"}'
    fi
    exit 0
}

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# Run from the plugin's own directory. Bun reads `.env` and `bunfig.toml` (which
# can `preload` arbitrary code) from the cwd, and the cwd here is the user's
# repository. main.ts takes the repository path from the hook payload instead.
cd "$ROOT" || exit 0
exec "$BUN" --env-file=/dev/null run "$ROOT/src/main.ts" "$TRIGGER"
