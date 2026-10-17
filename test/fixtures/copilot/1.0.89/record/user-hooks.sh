#!/bin/sh
# Add or remove a temporary user-level Copilot hook file that records every
# hook payload to <out-dir>/hooks.jsonl through hook.sh.
# Usage: user-hooks.sh on <out-dir> | user-hooks.sh off
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DIR="${COPILOT_HOME:-$HOME/.copilot}/hooks"
FILE="$DIR/overlord-fixture-recording.json"
case "${1:-}" in
  on)
    OUT="$2"
    [ ! -e "$FILE" ] || { echo "$FILE already exists" >&2; exit 1; }
    mkdir -p "$DIR"
    {
      printf '{"version":1,"hooks":{'
      sep=''
      for ev in sessionStart sessionEnd userPromptSubmitted preToolUse postToolUse \
        postToolUseFailure permissionRequest agentStop errorOccurred notification; do
        printf '%s"%s":[{"type":"command","bash":"%s/hook.sh %s","env":{"REC_HOOK_LOG":"%s/hooks.jsonl"},"timeoutSec":10}]' \
          "$sep" "$ev" "$HERE" "$ev" "$OUT"
        sep=','
      done
      printf '}}\n'
    } > "$FILE"
    ;;
  off)
    rm -f "$FILE"
    rmdir "$DIR" 2>/dev/null || true
    [ ! -e "$FILE" ] && echo "removed $FILE"
    ;;
  *)
    echo "usage: $0 on <out-dir> | off" >&2
    exit 2
    ;;
esac
