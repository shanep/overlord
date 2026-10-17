# Copilot CLI 1.0.89 fixtures

Real recordings of GitHub Copilot CLI 1.0.89 (`copilot --version`), made on
2026-10-16 on macOS with `gpt-5-mini` (0x premium multiplier, so every run
reports `premiumRequests: 0`). Seven prompts and about 11 model calls in all.
They are here so the Copilot adapter (N2 in `META-HARNESS.md`) can test its
parsers without starting a real agent.

All paths are scrubbed: the scratch folder is `/work` (the repo the agent
worked in is `/work/repo`) and the home folder is `/home/user`. See
[Scrubbing](#scrubbing) for what else changed.

## Files

| File                                       | What it is                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `print/01-plain.jsonl`                     | `-p --output-format json` stdout, plain answer, no tools                          |
| `print/02-shell.jsonl`                     | Same, one shell command allowed with `--allow-tool='shell(ls)'`                   |
| `print/03-edit.jsonl`                      | Same, one file edit allowed with `--allow-tool='write'` (a `view` then an `edit`) |
| `print/04-denied.jsonl`                    | Same, shell denied with `--deny-tool='shell'`                                     |
| `print/05-hooks.jsonl`                     | Same prompt as 02, made while the recording hooks were installed                  |
| `session-state/<id>/events.jsonl`          | The transcript each run left in `~/.copilot/session-state/<id>/`                  |
| `session-state/<id>/workspace.yaml`        | Session metadata (id, cwd, git root, branch, name, timestamps)                    |
| `session-state/<id>/checkpoints/index.md`  | Empty checkpoint table                                                            |
| `session-state/<id>/rewind-file-snapshots` | `tracking.json`, plus `index.json` and one backup for the edit run (`...0003`)    |
| `acp/06-acp.jsonl`                         | Both directions of a `copilot --acp` exchange over stdio                          |
| `hooks/hooks.jsonl`                        | Hook stdin payloads from run 05 and the ACP session                               |
| `otel/03-04.otel.jsonl`                    | OTel file export (spans and metrics) for runs 03 and 04                           |
| `record/`                                  | The scripts that made all of the above                                            |

Session ids: runs 01 to 05 are `11111111-1111-4111-8111-00000000000N`, set with
`--session-id`. The ACP session is `314df6e1-afd1-4b9c-bdf3-7cf94861398e`,
minted by Copilot. Each session folder also had an empty `.workspace-fork.lock`,
which is left out.

## How they were made

A scratch git repo with `README.md` and `calc.py` (`def add(a, b)`) under
`/work/repo`. From `record/`:

```sh
./run-print.sh /work                 # runs 01 to 04
./user-hooks.sh on /work/out         # add ~/.copilot/hooks/overlord-fixture-recording.json
./run-hooks.sh /work                 # run 05
./acp-driver.sh /work/repo /work/out/06-acp.jsonl
./user-hooks.sh off                  # remove the hook file again
SCRUB_EXTRA=<github-login> ./build-fixtures.sh /work <this-folder> <session ids...>
```

Every print run is
`copilot --model gpt-5-mini --output-format json --no-auto-update --session-id <id> -p '<prompt>' [--allow-tool|--deny-tool ...]`.
The prompts are in `run-print.sh` and `run-hooks.sh`.

## Schemas in the package

The package ships JSON schemas, not copied here:

- `~/Library/Caches/copilot/pkg/darwin-arm64/1.0.89/schemas/session-events.schema.json`
  (root `#/definitions/SessionEvent`, an `anyOf` of 153 event types, 79 of
  them marked `ephemeral: true`)
- `~/Library/Caches/copilot/pkg/darwin-arm64/1.0.89/schemas/api.schema.json`
  (JSON-RPC API with `server`, `session`, `clientSession`, `clientGlobal`)
- SDK typings in `.../1.0.89/copilot-sdk/*.d.ts`

The pattern is `~/Library/Caches/copilot/pkg/<platform>-<arch>/<version>/`.
`/opt/homebrew/bin/copilot` is the 1.0.88 Homebrew cask binary, and it runs
the newest downloaded package, which is why `--version` says 1.0.89. Pass
`--no-auto-update` to stop it from fetching a newer one mid-recording.

Event types in `session-events.schema.json` (1.0.89):

```text
session.start session.resume session.remote_steerable_changed session.error
session.idle session.title_changed session.schedule_created
session.schedule_cancelled session.schedule_rearmed
session.autopilot_objective_changed session.info session.indexed_search
session.warning session.model_change session.model_deselected
session.auto_tier_recommendation session.auto_tier_switch_failed
session.mode_changed session.mode_notice_delivered
session.session_limits_changed session.permissions_changed session.plan_changed
session.todos_changed session.memory_changed session.workspace_file_changed
session.handoff session.truncation session.snapshot_rewind session.shutdown
session.usage_checkpoint session.fusion_change_checkpoint
session.context_changed session.usage_info session.context_cleared
session.compaction_start session.compaction_complete session.task_complete
session.completion_receipt session.fusion_route_started
session.fusion_route_failed session.fusion_resolved session.fusion_handoff
session.fusion_commit_started session.fusion_completed
session.permission_recovery user.message pending_messages.modified
assistant.turn_start assistant.turn_retry agent.interrupted assistant.intent
assistant.fusion_phase_started assistant.fusion_phase_activity
assistant.fusion_phase_completed assistant.fusion_phase_failed
assistant.server_tool_progress assistant.reasoning assistant.reasoning_delta
assistant.tool_call_delta assistant.streaming_delta assistant.message
assistant.message_start assistant.message_delta assistant.turn_end
assistant.idle assistant.usage prompt_cache_break model.call_failure
model.call_finished model.call_start abort tool.user_requested
tool.execution_start tool.execution_partial_result tool.execution_progress
tool.execution_complete tool_search.activated skill.invoked skill.invoked_ref
skill.context_delivered skill.context_delivered_ref sandbox.decision
subagent.started subagent.configured subagent.completed subagent.failed
subagent.selected subagent.deselected hook.start hook.end hook.progress
session.binary_asset system.message system.notification permission.requested
permission.completed permission.carriedForward permission.messageAuthorization
permission.messageAuthorizationRead permission.messageAuthorizationDegraded
permission.assentDetected permission.contextualAuthorization
user_input.requested user_input.completed elicitation.requested
elicitation.completed sampling.requested sampling.completed mcp.oauth_required
mcp.oauth_completed mcp.headers_refresh_required mcp.headers_refresh_completed
session.custom_notification ui.ephemeral_query external_tool.requested
external_tool.completed command.queued command.execute command.completed
auto_mode_switch.requested auto_mode_switch.completed
session_limits_exhausted.requested session_limits_exhausted.completed
session.auto_mode_resolved session.managed_settings_resolved
session.managed_settings_enforced commands.changed capabilities.changed
exit_plan_mode.requested exit_plan_mode.completed session.tools_updated
session.background_tasks_changed workflow.run_updated workflow.run_started
workflow.run_settled session.skills_loaded session.custom_agents_updated
session.mcp_servers_loaded session.mcp_server_status_changed
session.mcp_server_removed session.mcp_server_needs_reconnect
mcp.tools.list_changed mcp.resources.list_changed mcp.prompts.list_changed
session.extensions_loaded session.canvas.opened session.canvas.registry_changed
session.canvas.closed session.canvas.unavailable session.canvas.recorded
session.canvas.removed session.extensions.attachments_pushed
mcp_app.tool_call_complete
```

## Format notes for the parser

### The event envelope

Every line in `events.jsonl` and every line but the last in the print output is
`{type, data, id, timestamp, parentId}`, plus `ephemeral: true` on ephemeral
events (the schema also allows `agentId` for subagents). `timestamp` is an ISO
string. `id` is a UUID.

`parentId` chains the persisted events in order: each one points at the
persisted event before it, and `session.start` has `parentId: null`. Ephemeral
events all point at the latest persisted event, so they are leaves and can be
dropped without breaking the chain.

### Print output vs events.jsonl

They overlap but neither is a superset.

- **Only in print output:** every ephemeral event (`assistant.message_delta`,
  `assistant.reasoning_delta`, `assistant.tool_call_delta`,
  `assistant.message_start`, `model.call_start`, `model.call_finished`,
  `tool.execution_partial_result`, `session.background_tasks_changed`,
  `session.mcp_servers_loaded`, `session.tools_updated`, `assistant.idle`, and
  so on) and a final `{"type":"result", timestamp, sessionId, exitCode, usage}`
  line with no `id` or `data`.
- **Only in events.jsonl:** `session.start`, `system.message` (the full system
  prompt), `hook.start` and `hook.end`, `permission.requested` and
  `permission.completed`, `abort`, and `session.shutdown`.
- The first print event (`user.message`) has a `parentId` that is not in the
  print output, because it points at `session.start` or `system.message`.

### Ids and session id

- `--session-id <uuid>` sets the id of a new session up front. The folder is
  `~/.copilot/session-state/<uuid>/`, `session.start.data.sessionId` and the
  `result` line's `sessionId` match it. Confirmed for runs 01 to 05.
- ACP `session/new` mints its own id and returns it in the result.
- `workspace.yaml` holds `id`, `cwd`, `git_root`, `branch`, `client_name`
  (`github/cli`), `name` (the first prompt), `user_named`, `created_at` and
  `updated_at`.

### Model, usage and cost

- **Model:** `session.start.data.selectedModel` and `reasoningEffort`,
  `session.tools_updated.data.model`, and `model` on `assistant.message`,
  `model.call_start`, `tool.execution_start` and `tool.execution_complete`.
- **Tokens:** not in the print output at all. The `result` line only has
  `premiumRequests`, `totalApiDurationMs`, `sessionDurationMs` and
  `codeChanges {linesAdded, linesRemoved, filesModified}`. Tokens are in
  `session.shutdown` (events.jsonl only): `tokenDetails {input, cache_read,
cache_write, output}.tokenCount`, and per model in
  `modelMetrics.<model>.usage {inputTokens, outputTokens, cacheReadTokens,
cacheWriteTokens, reasoningTokens}` with `requests {count, cost}`.
  `currentTokens`, `systemTokens`, `conversationTokens` and
  `toolDefinitionsTokens` give context size. `assistant.usage` is in the
  schema but never showed up in these runs.
- **Cost and quota:** `session.usage_checkpoint.data.totalNanoAiu` and
  `totalPremiumRequests` (also on `session.shutdown`). AI credits are in nano
  units. `requests.cost` was 0 for this 0x model. OTel `chat` spans carry
  `github.copilot.cost` and `github.copilot.nano_aiu` per call. In ACP each
  model in `availableModels` has `_meta.copilotUsage` (the multiplier, for
  example `0x`, `0.33x`, `1x`, `14x`) and `_meta.copilotPriceCategory`.
- `session.usage_checkpoint.data.promptCacheBreakState` lists each model call
  with `vendor`, `api_endpoint` (`/responses`), `reasoning_effort` and the tool
  list (trimmed here).

### Tool calls

- `assistant.message.data.toolRequests[]` has `{toolCallId, name, arguments,
type: "function", intentionSummary, toolTitle}`.
- `tool.execution_start.data` has `toolCallId`, `toolName` (`bash`, `view`,
  `edit`, ...), `arguments`, `turnId`, `model`, `toolTitle`, and for shell
  `shellToolInfo`.
- `tool.execution_complete.data` has `success`, then `result {content,
detailedContent}` (a unified diff for `view` and `edit`) or `error {message,
code}`, plus `toolTelemetry`. Edits report `metrics.linesAdded` and
  `linesRemoved`.
- Shell tool is `bash` in events and hooks, but `shell(...)` in
  `--allow-tool` and `--deny-tool`. `--allow-tool='shell(ls)'` still let the
  model run `ls -1 | wc -l`.

### Permissions

- **Denied by flag** (run 04): no `permission.*` event. The tool fails with
  `tool.execution_complete.data.success: false` and `error.code: "denied"`.
  The message reads "Permission to run this tool was denied due to the
  following rules: \`shell\`". The OTel span has `error.type: "denied"`.
- **Asked over ACP:** events.jsonl gets `permission.requested` (with
  `permissionRequest.kind: "shell"`, `fullCommandText`, `commands`,
  `commandSegments`, `canOfferSessionApproval`) and `permission.completed`
  with `result.kind: "denied-interactively-by-user"` and
  `decisionSource: "human_response"`.

### ACP (`acp/06-acp.jsonl`)

Each line is `{dir, proc, t, msg}`: `dir` is `send` (client to Copilot),
`recv` or `stderr`, `proc` is `A` (first process) or `B` (second process for
`session/load`), `msg` is the raw JSON-RPC message. Messages are
newline-delimited JSON-RPC 2.0.

- `initialize` returns `protocolVersion: 1`, `agentInfo {name: "Copilot",
version: "1.0.89"}`, `agentCapabilities {loadSession: true, mcpCapabilities
{http, sse}, promptCapabilities {image: true, audio: false, embeddedContext:
true}, sessionCapabilities {close: {}, list: {}}}`, and an `authMethods`
  entry `copilot-login` whose `_meta.terminal-auth` runs `copilot login`.
- Optional methods: it advertises `session/load`, `session/list` and
  `session/close` (`close` was not called here), and `session/set_mode`
  answered `{}`. There is no `session/resume` capability.
- `session/new` returns `sessionId`, `models {currentModelId,
availableModels}`, `modes` (ids are URLs such as
  `https://agentclientprotocol.com/protocol/session-modes#agent`, `#plan`,
  `#autopilot`) and `configOptions` (selects for `mode` and `model`).
- Updates seen: `available_commands_update`, `config_option_update`,
  `session_info_update` (title), `usage_update {used, size}` (context window,
  not tokens billed), `agent_thought_chunk`, `agent_message_chunk`,
  `tool_call` (`kind: "execute"`, `rawInput.command`) and `tool_call_update`.
- `session/request_permission` comes from Copilot with JSON-RPC id `0`
  (Copilot numbers its own requests from 0). Options are `allow_once`,
  `allow_always` and `reject_once`. There is no `reject_always`. After
  `reject_once` the tool call updates to `status: "failed"`,
  `rawOutput {code: "rejected"}`.
- `session/prompt` resolves with `stopReason` and `usage {inputTokens,
outputTokens, totalTokens, thoughtTokens, cachedReadTokens,
cachedWriteTokens}`. After `session/cancel` it resolves with
  `stopReason: "cancelled"`, but `usage` repeats the previous turn's numbers
  exactly, so do not add it to a total. events.jsonl records
  `abort {reason: "user_initiated"}`.
- `session/load` in a fresh process replays history as `user_message_chunk`,
  `agent_message_chunk`, `tool_call` and `tool_call_update` updates (no
  thought chunks), then returns `models`, `modes` and `configOptions`.
- `session/list {cwd}` returns `sessions [{sessionId, cwd, title,
updatedAt}]`, including the `-p` sessions from the same folder.

### Hooks (`hooks/hooks.jsonl`)

Each line is `{event, payload}`, where `payload` is the hook's stdin. Hook
config format: `{"version": 1, "hooks": {"<event>": [{"type": "command",
"bash": "...", "env": {...}, "timeoutSec": 10}]}}` in
`~/.copilot/hooks/*.json`.

- Every payload has `sessionId`, `cwd` and `timestamp` as **epoch
  milliseconds** (a number, unlike the ISO strings in events).
- Order in a print run: `userPromptSubmitted` fires before `sessionStart`
  (`source: "new"`, `initialPrompt`), then `preToolUse {toolName, toolArgs}`,
  `permissionRequest {hookName, toolName, toolInput, permissionSuggestions}`,
  `postToolUse {toolName, toolArgs, toolResult {resultType,
textResultForLlm}}`, `agentStop {transcriptPath, stopReason: "end_turn"}` and
  `sessionEnd {reason: "complete"}`.
- `transcriptPath` in `agentStop` is the session's `events.jsonl`, an easy way
  to find the transcript from a hook.
- In run 05 `permissionRequest` fired for a command the flags already
  allowed, and the command ran (the hook printed nothing).
- Over ACP: `notification {message, title: "Permission needed",
notification_type: "permission_prompt", hook_event_name: "Notification"}`
  fired when the prompt went to the client. `sessionEnd {reason: "complete"}`
  fired after **each** prompt, the cancelled one included. `agentStop` did not
  fire, and the rejected tool got neither `postToolUse` nor
  `postToolUseFailure`.
- Hooks also land in events.jsonl as `hook.start {hookInvocationId, hookType,
input}` and `hook.end {hookInvocationId, hookType, success}`. The
  `preToolUse` input there is `toolCalls [{id, name, args}]`, not the
  `toolName`/`toolArgs` the hook command gets.
- A repo-level `.github/hooks/*.json` in the scratch repo did not fire in
  `-p` mode (I did not track down why, possibly folder trust), so these came
  from the user-level file. It was removed after recording.

### OTel (`otel/03-04.otel.jsonl`)

`COPILOT_OTEL_FILE_EXPORTER_PATH=<file>` turns OTel on and picks the file
exporter (JSON lines). Each process appends, so this file holds runs 03 and 04.

- Spans: `{type: "span", traceId, spanId, parentSpanId, name, kind,
startTime, endTime, attributes, status, events, resource,
instrumentationScope}`. Times are `[seconds, nanos]`. Names are
  `invoke_agent`, `chat <model>` and `execute_tool <tool>`.
  `gen_ai.conversation.id` is the session id.
- `chat` spans carry `gen_ai.usage.input_tokens`, `output_tokens`,
  `cache_read.input_tokens`, `reasoning.output_tokens`,
  `gen_ai.response.finish_reasons`, `github.copilot.cost`, `nano_aiu`,
  `turn_id` and `interaction_id`. This is the only per-call token source in
  `-p` mode.
- Metrics: `{type: "metric", name, description, unit, dataPoints}`, the names
  `copilot help monitoring` lists. No content is captured unless
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`.

## Scrubbing

`record/scrub.sh` (Node code fed to `node -`, so the repo lint rules skip it) rewrote every file:

- Scratch folder to `/work`, home folder to `/home/user` (with and without the
  leading slash, since diffs write `a/Users/...`), user name, host name and
  GitHub login to placeholders. Hex-encoded paths in
  `rewind-file-snapshots/index.json` are decoded, scrubbed and encoded again.
- Emails, `gh?_` and `github_pat_` tokens, JWTs and `Bearer` values to
  placeholders. Request ids (`request_id`, `github_request_id`,
  `service_request_id`, `apiCallId`) to `00000000-0000-4000-8000-...`.
- Opaque blobs (`encryptedContent`, `encrypted_content`, `reasoningOpaque`,
  `model_call_id`, `gen_ai.response.id`) to `<trimmed N chars>`.
- Strings over 2,400 characters (the system prompt) cut to 1,200 with
  `[trimmed N chars]`. `tools` and `availableCommands` lists cut to 3 entries
  plus `{trimmed: N}`.
- Runs of more than 5 `assistant.reasoning_delta` (per `reasoningId`),
  `session.background_tasks_changed` or ACP `agent_thought_chunk` cut to the
  first 5. Message and tool call deltas are kept whole, so they still join up
  to the full `assistant.message` text and arguments.
- Em and en dashes to `-`. The `.json`, `.yaml` and `.md` side files went
  through prettier.
