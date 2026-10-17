#!/bin/sh
# One `copilot -p` run with a single allowed shell command, made while the
# temporary user hook file from user-hooks.sh is in place.
# Usage: run-hooks.sh <scratch-dir>
set -eu
S="$1"
cd "$S/repo"
copilot --model "${MODEL:-gpt-5-mini}" --output-format json --no-auto-update \
  --session-id 11111111-1111-4111-8111-000000000005 \
  -p 'Run the shell command `ls` and reply with how many files it listed.' \
  --allow-tool='shell(ls)' > "$S/out/05-hooks.jsonl" 2> "$S/out/05-hooks.stderr"
