#!/bin/sh
# Copilot command hook that records its payload and makes no decision.
# Usage (from a hooks JSON entry): hook.sh <eventName>
# Appends one line {"event": <name>, "payload": <stdin JSON>} to $REC_HOOK_LOG.
event="$1"
log="${REC_HOOK_LOG:-/tmp/copilot-hooks.jsonl}"
payload=$(tr -d "\n\r")
[ -n "$payload" ] || payload=null
printf '{"event":"%s","payload":%s}\n' "$event" "$payload" >> "$log"
exit 0
