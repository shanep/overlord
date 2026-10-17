# Codex CLI 0.163.0 fixtures

Real recordings of Codex CLI 0.163.0 (`codex-cli 0.163.0`, macOS arm64) on a
ChatGPT free plan account, made on 2026-10-16. The model was `gpt-6-luna` at
`model_reasoning_effort=low`. Every session ran in a scratch git repo with two
files (`README.md`, `notes.txt` containing `hello`). These are input for the
N3 Codex adapter (META-HARNESS.md).

All files went through `record/build-fixtures.sh`, which replaces the home
path with `/home/user`, the scratch repo with `/work/repo`, the account,
user and installation ids with zero UUIDs or `user-XXXX...`, emails with
`user@example.com`, the hostname with `host.example` and the time zone with
`America/Denver`. Strings over 2000 characters are cut to 1000 with a
`...[trimmed for fixture, N chars]` marker (mostly `base_instructions` and the
skills developer message).

## Files

| Path                          | What it is                                                                  |
| ----------------------------- | --------------------------------------------------------------------------- |
| `exec/plain.jsonl`            | `codex exec --json` stdout, plain answer ("pong")                           |
| `exec/shell.jsonl`            | `codex exec --json` stdout, one `ls`                                        |
| `exec/edit.jsonl`             | `codex exec --json` stdout, `cat` then an `apply_patch` edit of `notes.txt` |
| `exec/hooks-otel.jsonl`       | `codex exec --json` stdout for the hooks and OTel run (one `cat`)           |
| `rollouts/rollout-*.jsonl`    | The 5 transcripts those runs wrote under `~/.codex/sessions/2026/10/16/`    |
| `app-server/session.jsonl`    | Full `codex app-server` stdio exchange, both directions                     |
| `app-server/hooks-list.jsonl` | Two `hooks/list` exchanges (no model turn) showing hook trust status        |
| `app-server/methods.json`     | Every method name from `codex app-server generate-json-schema`              |
| `otel/requests.jsonl`         | The 7 OTLP/HTTP JSON request bodies from the hooks and OTel run, sampled    |
| `otel/trace-span-counts.json` | Span name counts from the two full trace exports before sampling            |
| `record/*.sh`                 | The scripts that made all of this                                           |

Which rollout came from which run:

- `22-06-42-...-6060-...` is `exec/plain`
- `22-06-59-...-a59d-...` is `exec/shell`
- `22-07-10-...-d128-...` is `exec/edit`
- `22-08-21-...-e3ce-...` is `app-server/session` (both turns)
- `22-10-00-...-67aa-...` is `exec/hooks-otel`

## Commands

```sh
# codex exec, from record/exec.sh
codex exec --json -C <repo> -s read-only -c model_reasoning_effort=low "<prompt>" </dev/null
# the edit run used -s workspace-write

# app-server, from record/app-server.sh
codex app-server -c model_reasoning_effort=low

# schema (4.4 MB, 324 files, not committed)
codex app-server generate-json-schema --out <dir>
codex app-server generate-ts --out <dir>   # same protocol as TypeScript
```

`codex exec` prints `Reading additional input from stdin...` on stderr and
reads stdin when it is not a TTY, so close stdin (`</dev/null`).

## `codex exec --json` stream

One JSON object per line, `type` is one of `thread.started`, `turn.started`,
`item.started`, `item.completed`, `turn.completed`.

- `thread.started` comes first and carries `thread_id` (a UUIDv7 like
  `01a1480a-6060-7fc1-...`). This is the only place the id shows up. It
  matches the rollout file name and `session_meta.payload.id`.
- There is no turn id anywhere in the exec stream.
- Item ids are per run counters (`item_0`, `item_1`), not the ids in the
  rollout.
- Item types seen: `agent_message` (`text`), `command_execution` (`command`
  as one string like `/bin/zsh -lc ls`, `aggregated_output`, `exit_code`,
  `status`), `file_change` (`changes: [{path, kind}]`, no diff), `error`
  (`message`). Agent messages only get `item.completed`; commands and file
  changes get `item.started` then `item.completed`.
- Config warnings arrive as `error` items before `turn.started`. In
  `exec/hooks-otel.jsonl` they are `clamping SessionEnd hook timeout to 3s`.
- `turn.completed.usage` has `input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`,
  summed over every model call in the turn. `cached_input_tokens` is part of
  `input_tokens`, not on top of it.

## Rollout transcripts

Each line is `{timestamp, ordinal, type, payload}`. `ordinal` counts from 0.
Record types and the `payload.type` values seen:

- `session_meta` (line 1): `id` and `session_id` (both the thread id),
  `cwd`, `originator` (`codex_exec`, or the app-server `clientInfo.name`),
  `cli_version`, `source` (`exec` or `vscode`, app-server threads say
  `vscode`), `model_provider`, `base_instructions`, `git` (commit and branch),
  `history_mode: "paginated"`, and `creator_user_id` and
  `creator_account_id` (scrubbed here, real account ids in the wild).
- `turn_context`: `turn_id`, `cwd`, `approval_policy`, `sandbox_policy`,
  model and effort for the turn.
- `world_state`: a snapshot of environment, AGENTS.md, model and mode.
- `response_item`: model input and output. `message` with `role` of
  `developer`, `user` or `assistant` (assistant ones have `phase`:
  `commentary` or `final_answer`), `custom_tool_call` and
  `custom_tool_call_output`.
- `event_msg`: `task_started` (turn start, `turn_id`,
  `model_context_window: 258400`), `thread_settings_applied`,
  `item_completed`, `token_count`, `task_complete` (`last_agent_message`,
  `duration_ms`, `time_to_first_token_ms`), `turn_aborted`
  (`reason: "interrupted"`).
- `token_usage_record`: one per model response, keyed by `response_id`
  (`resp_...`), with `usage` (this call), `turn_token_usage` and
  `thread_token_usage` (running totals).

Things that surprised me:

- Tool calls go through "code mode". The model never calls a shell tool
  directly. It sends `custom_tool_call` with `name: "exec"` and JavaScript in
  `input`, like `await tools.exec_command({cmd:"cat notes.txt"})` or
  `tools.apply_patch(...)`. The real command shows up in
  `event_msg/item_completed` with `item.type` of `CommandExecution`
  (`command` as an argv array, `parsed_cmd`, `exit_code`, `aggregated_output`,
  `duration`) or `FileChange` (`changes` keyed by path, with `unified_diff`).
  Item ids there are `exec-<uuid>`, and they match the app-server item ids.
- `event_msg/item_completed` also carries `UserMessage` and `AgentMessage`,
  so a reader can follow a session from `event_msg` alone and skip
  `response_item`.
- Usage is written twice per response: `token_usage_record` and
  `event_msg/token_count` (`info.total_token_usage`,
  `info.last_token_usage`). Count `token_usage_record` by `response_id`. The
  app-server rollout has 3 `token_count` lines for 2 records, since the
  interrupt writes one more `token_count` with no new call.
- Rate limits are only in `token_count.rate_limits`: `limit_id: "codex"`,
  `primary {used_percent, window_minutes: 43200, resets_at}` (epoch seconds),
  `secondary: null`, `credits`, `plan_type: "free"`. A free plan has one 30
  day window.
- A declined approval leaves no approval record and no `CommandExecution`
  item. The only trace is `custom_tool_call_output` text
  `exec_command failed: CreateProcess { message: "Rejected(\"rejected by user\")" }`.
- An interrupted turn ends with `turn_aborted` and no `task_complete`.

## History and state

Neither `codex exec` nor `codex app-server` wrote `~/.codex/history.jsonl`, so
there is nothing to copy. Thread metadata lives in SQLite instead:
`~/.codex/state_5.sqlite` has a `threads` table with `id`, `rollout_path`,
`cwd`, `title`, `source`, `model`, `reasoning_effort`, `tokens_used`,
`first_user_message`, `cli_version`, `git_sha`, `git_branch`,
`created_at_ms`, `updated_at_ms`, `archived` and more, and
`thread_history_1.sqlite` has `thread_turns` and `thread_items`.

Codex also wrote `~/.codex/config.toml` by itself on the first exec in the
scratch repo, adding `[projects."<repo>"] trust_level = "trusted"`.

## app-server

`app-server/session.jsonl` lines are `{dir, t, msg}`: `dir` is `send`
(client to server) or `recv`, `t` is milliseconds since start, `msg` is the
JSON-RPC message. The script ran:

1. `initialize` with `clientInfo {name, title, version}`, then the
   `initialized` notification.
2. `account/rateLimits/read` (params `null`).
3. `thread/start` with `cwd`, `approvalPolicy: "untrusted"`,
   `sandbox: "read-only"`.
4. `turn/start` asking for `touch approved.txt`, with the approval declined.
5. `turn/start` asking for a 400 word story, then `turn/interrupt` after the
   first `item/agentMessage/delta`.
6. `account/rateLimits/read` again.

Format facts:

- Server messages leave out `"jsonrpc": "2.0"`. Server requests use their own
  id counter starting at 0, separate from client ids.
- The thread id arrives in the `thread/start` response at
  `result.thread.id`, along with `result.thread.path` (the rollout file) and
  `result.model`. A `thread/started` notification follows. The turn id is in
  the `turn/start` response at `result.turn.id` and in `turn/started`.
- Notifications seen: `remoteControl/status/changed`, `account/updated`
  (`authMode`, `planType`), `thread/started`,
  `mcpServer/startupStatus/updated`, `thread/status/changed`
  (`{type: "active", activeFlags: []}`, `["waitingOnApproval"]`, or
  `{type: "idle"}`), `turn/started`, `item/started`, `item/completed`,
  `item/agentMessage/delta`, `serverRequest/resolved`,
  `thread/tokenUsage/updated`, `account/rateLimits/updated`,
  `turn/completed`. Item types are camelCase: `userMessage`,
  `commandExecution`, `agentMessage`.
- Approval: the server sends request `item/commandExecution/requestApproval`
  with `threadId`, `turnId`, `itemId`, `command`, `cwd`, `commandActions`,
  `proposedExecpolicyAmendment` and `availableDecisions`
  (`["accept", {acceptWithExecpolicyAmendment: ...}, "cancel"]`). The client
  answered `{decision: "decline"}`. `decline` is not in `availableDecisions`
  but the schema allows it and the server took it. Then
  `serverRequest/resolved {threadId, requestId}` and `item/completed` with
  `status: "declined"`. `cancel` would decline and interrupt the turn.
- Interrupt: `turn/interrupt {threadId, turnId}` returns `{}`, then
  `turn/completed` with `turn.status: "interrupted"` and `items: []`.
- Usage: `thread/tokenUsage/updated` after every model call, with
  `tokenUsage.total` and `tokenUsage.last` (camelCase `inputTokens`,
  `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`,
  `reasoningOutputTokens`, `totalTokens`) and `modelContextWindow`.
- Rate limits: `account/rateLimits/updated` follows each
  `thread/tokenUsage/updated`, with `rateLimits {limitId, primary
{usedPercent, windowDurationMins, resetsAt}, secondary, credits, planType}`.
  The `account/rateLimits/read` result adds `rateLimitsByLimitId` and
  `accountId` (scrubbed).
- Every notification has `emittedAtMs`.

## Hooks

No hook payloads were recorded. Codex 0.163.0 skips any hook that is not
trusted, and it does so silently, apart from the timeout clamp warnings. The
run in `record/hooks-otel.sh` put all 12 events (`SessionStart`,
`SessionEnd`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStart`,
`SubagentStop`, `Stop`, `Interrupt`) in a temporary `~/.codex/hooks.json`, and
none fired. The file was removed afterwards.

`app-server/hooks-list.jsonl` shows how trust looks from `hooks/list`: each
hook has a `key` (like `/<session-flags>/config.toml:stop:0:0`),
`currentHash` (`sha256:...`), `source` (`user`, `project`, `sessionFlags` and
others) and `trustStatus` (`managed`, `untrusted`, `trusted`, `modified`).
Event names there are camelCase (`stop`, `preToolUse`). Hooks can also come
from `-c hooks.<Event>=[...]` (source `sessionFlags`). The binary stores
trust as `hooks.state."<key>".trusted_hash` in the user `config.toml`. The
second exchange passes that key with `-c` and the hook stays `untrusted`, so
a `-c` override does not grant trust. To record payloads, trust the hooks
with `/hooks` in the TUI, or add `--dangerously-bypass-hook-trust` to the
exec call in `record/hooks-otel.sh`.

## OTel

`-c` overrides are enough, with no `config.toml` edit:

```sh
-c otel.environment=fixture
-c 'otel.exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/logs",protocol="json"}}'
-c 'otel.trace_exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/traces",protocol="json"}}'
-c 'otel.metrics_exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/metrics",protocol="json"}}'
```

`otel/requests.jsonl` lines are `{path, method, contentType, body}`, where
`body` is the OTLP JSON. One short exec run sent 4 log, 2 trace and 1 metrics
request. The raw traces were 980 KB (340 `fs.get_metadata` spans alone), so
only a few span names are kept, at most 2 each. Metrics keep `codex.turn.*`,
`codex.conversation.*`, `codex.tool.*`, `codex.thread.started`,
`codex.websocket.request*`, `codex.process.start` and
`codex.rollout.size_bytes`. Logs are complete.

- Resource attributes: `service.name` (`codex_exec`), `service.version`,
  `env`, `host.name`.
- Log events (`event.name` attribute): `codex.conversation_starts`
  (approval and sandbox policy, effort, MCP servers),
  `codex.startup_phase`, `codex.user_prompt` (`prompt` is `[REDACTED]`
  unless `otel.log_user_prompt=true`), `codex.api_request`,
  `codex.websocket_connect`, `codex.websocket_request`, `codex.sse_event`
  (`event.kind: "response.completed"` with `input_token_count`,
  `output_token_count`, `cached_token_count`, `cache_write_token_count`,
  `reasoning_token_count`, `tool_token_count`, `ttft_ms`),
  `codex.turn_ttft`, `codex.tool_decision` (`tool_name`, `call_id`,
  `decision`, `source`) and `codex.tool_result` (`arguments`, `output`,
  `duration_ms`, `success`).
- Every log event carries `conversation.id` (the thread id), `model`,
  `originator`, `auth_mode`, `user.account_id` and `user.email`. Those last
  two are real values in a live export, so treat OTel output as personal data.
- Numbers in log attributes are strings (`"input_token_count": "13284"`).
- The first `codex.sse_event` (11182 input, 0 output) is a startup prewarm
  call. It is not in `turn.completed.usage`, so summing every `sse_event`
  overcounts.

## Recording again

Copy `record/` into an empty folder, create `repo/` next to it with a git
repo and the two files, then run the scripts from there. They write to
`out/`. `build-fixtures.sh <dest> <rollout files...>` scrubs `out/` into a
fixture folder. `app-server.sh`, `hooks-list.sh` and `otel-receiver.sh` are
Node code inside a heredoc, so the repo's ESLint and knip leave them alone.
The whole set took 6 model turns.
