#!/bin/sh
# Scrub the raw recordings into the fixture folder.
# Usage: build-fixtures.sh <scratch-dir> <fixture-dir> <session-id>...
# Reads <scratch-dir>/out (stdout, ACP, hooks, OTel) and copies each named
# session from the Copilot session-state folder.
set -eu
S="$1"; F="$2"; shift 2
HERE=$(cd "$(dirname "$0")" && pwd)
STATE="${COPILOT_HOME:-$HOME/.copilot}/session-state"
scrub() { "$HERE/scrub.sh" "$S" "$1" "$2"; }

mkdir -p "$F/print" "$F/acp" "$F/hooks" "$F/otel" "$F/session-state"
for n in 01-plain 02-shell 03-edit 04-denied 05-hooks; do
  scrub "$S/out/$n.jsonl" "$F/print/$n.jsonl"
done
scrub "$S/out/06-acp.jsonl" "$F/acp/06-acp.jsonl"
scrub "$S/out/hooks.jsonl" "$F/hooks/hooks.jsonl"
scrub "$S/out/03-edit.otel.jsonl" "$F/otel/03-04.otel.jsonl"

for id in "$@"; do
  src="$STATE/$id"
  dst="$F/session-state/$id"
  mkdir -p "$dst"
  (cd "$src" && find . -type f ! -name ".*" | sort) | while read -r rel; do
    rel=${rel#./}
    mkdir -p "$dst/$(dirname "$rel")"
    if [ -s "$src/$rel" ]; then
      scrub "$src/$rel" "$dst/$rel"
    else
      : > "$dst/$rel"
    fi
  done
done
