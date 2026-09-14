#!/usr/bin/env bash
# Locate a Bun runtime and hand the hook invocation to src/main.ts.
#
# Bun is the plugin's only runtime dependency. If it is missing we must not
# break the user's commit (this is a PostToolUse hook, the commit has already
# happened), so we exit 0 and tell the user how to install it. The reminder is
# rate-limited to once a day via a marker file in the plugin's data directory.
set -u

TRIGGER="${1:-}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-${HOME:-}/.claude/plugins/data/console}"

find_bun() {
    if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
    for candidate in "${BUN_INSTALL:-}/bin/bun" "${HOME:-}/.bun/bin/bun"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
    done
    return 1
}

BUN="$(find_bun)" || {
    mkdir -p "$DATA_DIR" 2>/dev/null
    marker="$DATA_DIR/bun-missing-notified"
    if [ -z "$(find "$marker" -mtime -1 2>/dev/null)" ]; then
        touch "$marker" 2>/dev/null
        printf '%s\n' '{"systemMessage":"Amplify Console: Bun is not installed, so detections did not run. Install it with: curl -fsSL https://bun.sh/install | bash"}'
    fi
    exit 0
}

# --env-file=/dev/null: Bun otherwise loads `.env` from the cwd, which is the
# user's repository, so a repo-shipped file could point AMPLIFY_* elsewhere.
exec "$BUN" --env-file=/dev/null run "${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}/src/main.ts" "$TRIGGER"
