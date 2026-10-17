#!/usr/bin/env bash
# Record `codex exec --json` streams for the Codex fixtures.
# Usage: exec.sh <name> <sandbox> <prompt> [extra codex args...]
# Writes out/exec-<name>.jsonl (stdout) and out/exec-<name>.stderr.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
name="$1"
sandbox="$2"
prompt="$3"
shift 3

codex="${CODEX_BIN:-codex}"
mkdir -p "$here/out"

set +e
"$codex" exec --json \
  -C "$here/repo" \
  -s "$sandbox" \
  -c model_reasoning_effort=low \
  "$@" \
  "$prompt" \
  </dev/null >"$here/out/exec-$name.jsonl" 2>"$here/out/exec-$name.stderr"
status=$?
set -e
echo "exit=$status"
