#!/usr/bin/env bash
# Record Codex hook payloads and OTel bodies from one short exec session.
# Writes a temporary ~/.codex/hooks.json (refuses if one already exists) that
# sends every hook event to log-hook.sh, starts otel-receiver.mjs on
# 127.0.0.1:4318, runs one exec turn with [otel] set through -c overrides,
# then removes hooks.json and stops the receiver.
#
# Codex 0.163.0 skips hooks that are not trusted, and trust is stored as
# hooks.state."<key>".trusted_hash in the user config.toml (a -c override of
# that key is ignored). So this run only fires hooks if they were trusted
# with /hooks in the TUI first, or if --dangerously-bypass-hook-trust is added
# to the exec call below. Without either, out/hooks.jsonl stays empty.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
codex="${CODEX_BIN:-codex}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
hooks_file="$codex_home/hooks.json"
port=4318

if [ -e "$hooks_file" ]; then
  echo "refusing: $hooks_file already exists" >&2
  exit 1
fi

mkdir -p "$here/out"
rm -f "$here/out/hooks.jsonl" "$here/out/otel.jsonl"

hook_cmd="/bin/sh $here/record/log-hook.sh"
node -e '
const events = ["SessionStart","SessionEnd","PreToolUse","PermissionRequest","PostToolUse",
  "PreCompact","PostCompact","UserPromptSubmit","SubagentStart","SubagentStop","Stop","Interrupt"];
const hooks = {};
for (const e of events) hooks[e] = [{ hooks: [{ type: "command", command: process.argv[1], timeout: 10 }] }];
process.stdout.write(JSON.stringify({ description: "Overlord fixture recorder (temporary)", hooks }, null, 2) + "\n");
' "$hook_cmd" >"$hooks_file"

OTEL_OUT="$here/out/otel.jsonl" PORT="$port" bash "$here/record/otel-receiver.sh" &
receiver=$!

cleanup() {
  rm -f "$hooks_file"
  kill "$receiver" 2>/dev/null || true
}
trap cleanup EXIT

sleep 1
base="http://127.0.0.1:$port"
set +e
"$codex" exec --json \
  -C "$here/repo" \
  -s read-only \
  -c model_reasoning_effort=low \
  -c otel.environment=fixture \
  -c "otel.exporter={otlp-http={endpoint=\"$base/v1/logs\",protocol=\"json\"}}" \
  -c "otel.trace_exporter={otlp-http={endpoint=\"$base/v1/traces\",protocol=\"json\"}}" \
  -c "otel.metrics_exporter={otlp-http={endpoint=\"$base/v1/metrics\",protocol=\"json\"}}" \
  "Run the shell command 'cat notes.txt' once, then reply with its first line only." \
  </dev/null >"$here/out/exec-hooks-otel.jsonl" 2>"$here/out/exec-hooks-otel.stderr"
status=$?
set -e
# Give the batch exporters a moment to flush.
sleep 3
echo "exit=$status"
