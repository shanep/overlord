#!/bin/sh
# Codex command hook: append the stdin JSON payload, one line per call, to
# out/hooks.jsonl next to this script's parent folder. Prints nothing, so
# Codex treats every hook as a no-op.
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$here/out"
payload="$(cat)"
printf '%s\n' "$payload" | tr -d '\n' >>"$here/out/hooks.jsonl"
printf '\n' >>"$here/out/hooks.jsonl"
exit 0
