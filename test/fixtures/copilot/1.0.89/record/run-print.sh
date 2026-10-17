#!/bin/sh
# Record `copilot -p --output-format json` runs in a scratch git repo.
# Usage: run-print.sh <scratch-dir>
# The scratch dir holds repo/ (a tiny git repo with README.md and calc.py)
# and out/, where each run's stdout and stderr land.
set -eu
S="$1"
OUT="$S/out"
MODEL="${MODEL:-gpt-5-mini}"
mkdir -p "$OUT"
cd "$S/repo"

run() {
  name="$1"; id="$2"; shift 2
  copilot --model "$MODEL" --output-format json --no-auto-update \
    --session-id "$id" "$@" > "$OUT/$name.jsonl" 2> "$OUT/$name.stderr" || echo "$name exit $?"
}

# 1. A plain answer, no tools.
run 01-plain 11111111-1111-4111-8111-000000000001 -p 'Reply with the word ok'

# 2. One shell command, with only that command allowed.
run 02-shell 11111111-1111-4111-8111-000000000002 \
  -p 'Run the shell command `ls` and reply with how many files it listed.' \
  --allow-tool='shell(ls)'

# Runs 3 and 4 write OTel to one file (each process appends its signals).
export COPILOT_OTEL_FILE_EXPORTER_PATH="$OUT/03-edit.otel.jsonl"

# 3. One file edit.
run 03-edit 11111111-1111-4111-8111-000000000003 \
  -p 'In calc.py add the one-line docstring """Add two numbers.""" to add(). Change nothing else.' \
  --allow-tool='write'

# 4. A denied tool: shell is denied outright.
run 04-denied 11111111-1111-4111-8111-000000000004 \
  -p 'Run the shell command `ls` and reply with how many files it listed.' \
  --deny-tool='shell'
unset COPILOT_OTEL_FILE_EXPORTER_PATH
