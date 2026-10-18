# Background

<!-- cspell:words workstream workstreams -->

## Connector check

Checked 2026-10-16 at the start of planning. This plan is code work in this
repo, so it needs no connectors or MCP tools (no browser, Docs, Drive, Gmail
or Calendar). Workers that record fixtures need the agent CLIs themselves,
covered under Workstream N0.

## Words used in this plan

- **Agent**: a coding agent CLI that runs tools, such as Claude Code, Codex
  or Copilot. Code calls this `AgentId`. We say agent, not provider, so
  it does not get mixed up with the model backend.
- **Backend**: the model endpoint behind an agent. Today that is the Anthropic
  API or the boisestate.ai bridge. boisestate.ai is a backend for Claude Code,
  not an agent, and it stays that way in this plan.
- **Facet**: one optional part of an agent adapter (runtime, terminal,
  observer, hooks, telemetry, instructions, config, models). An agent fills in
  the facets it can and the UI hides the rest.

## Where things stand

The audit (five read-only passes over `src/`, `webview/`, `test/` and
`scripts/`, about 200 files that name Claude) found:

- **The event bus is already neutral.** `src/core/bus.ts:13` carries
  `session.upserted`, `agent.upserted`, `tool.upserted`, `request.recorded`,
  `feed.appended` and the permission events, and the store only reads the bus.
  Every new agent just has to produce those events.
- **The SDK coupling sits in one file.** `src/core/harness/sdk-types.ts` is
  the only importer of `@anthropic-ai/claude-agent-sdk`, but the port it
  defines (`QueryOptions`, `SessionQuery`, `canUseTool`) and the input to
  `harness/mapper.ts` are SDK shaped.
- **The terminal side is spread out.** `claude --bg`, `claude attach`,
  `claude agents --json`, `claude stop`, `--resume`, `--fork-session` and
  `--session-id` are called from about eight files in `src/core/app/`
  (`claude-tabs.ts`, `claude-bin.ts`, `idle-stop.ts`, `jobs.ts`,
  `relocate.ts`, `actions-session.ts`, `places.ts`, `worktrees.ts`) plus
  `surfaces/live.ts` and `surfaces/handoff.ts`.
- **The config side reads one `ClaudePaths` record** (`src/core/paths.ts:7`).
  Context resolution, knobs, authoring, connectors, sync, launch check and
  tuning all hang off it.
- **Every piece of text Overlord adds to a session goes in through Claude
  hooks** as `additionalContext` (coordination notes, launch check, connector
  briefing, `app/app.ts:228`). Other agents need another way in.
- **The shared model leaks Claude.** `Surface` lists only Claude products,
  `PermissionMode` is Claude's enum, `contextWindow()` only knows `claude-*`
  ids and gives every other model 200K, and nothing on a session says which
  agent produced it.
- **Two store bugs get worse with more sources.** Requests are keyed by
  `messageId`, so a transcript `msg_` id and an OTel `req_` id for the same
  call probably count twice. `agent.upserted` is last write wins, so a hook's
  empty agent node can overwrite the transcript's full one
  (`store/store.ts:257`, `:288`, `hooks/mapping.ts:107`).

[Appendix A](appendix-a-inventory.md) has the full inventory, file by file.

## What the other agents give us

From the research pass on 2026-10-16. Sources are in [Appendix B](appendix-b-sources.md). Each
agent's worker should recheck them, since these CLIs move fast.

|                     | Copilot CLI                                                                                                                        | Codex CLI                                                                                   | Gemini CLI (out of scope)                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Installed here      | Yes, 1.0.89                                                                                                                        | No                                                                                          | No (but `~/.gemini` exists)                                    |
| Best driver         | `@github/copilot-sdk` (JSON-RPC to the CLI's headless server) or `copilot --acp`                                                   | `codex app-server` (JSON-RPC over stdio)                                                    | `gemini --acp`                                                 |
| Approvals from code | Yes (`onPermissionRequest`, ACP)                                                                                                   | Yes (app-server `requestApproval` items)                                                    | Only over ACP                                                  |
| Interrupt           | `session.abort()`                                                                                                                  | `turn/interrupt`                                                                            | ACP `cancel`                                                   |
| Resume              | `--resume`, `--session-id` (sets a new session's id)                                                                               | `exec resume`, `thread/resume`                                                              | `--resume`, ACP `loadSession`                                  |
| Transcripts         | `~/.copilot/session-state/<uuid>/events.jsonl` (schema ships in the package)                                                       | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (undocumented)                               | `~/.gemini/tmp/<hash>/chats/` (format changed across versions) |
| Hooks               | `~/.copilot/hooks/*.json`, `.github/hooks/*.json`, can deny `preToolUse`                                                           | `~/.codex/hooks.json` or `[hooks]`, Claude-like event names, `PermissionRequest` can decide | `hooks` in `settings.json`, `BeforeTool` can deny              |
| OTel                | `COPILOT_OTEL_ENABLED`, HTTP only                                                                                                  | `[otel]` in `config.toml`                                                                   | `telemetry.*` or `GEMINI_TELEMETRY_*`                          |
| Instructions        | `AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` (`applyTo` globs), also reads `CLAUDE.md` | `AGENTS.md` root down to cwd, byte cap                                                      | `GEMINI.md`, name settable, `@file` imports                    |
| Settings            | `~/.copilot/settings.json` (JSONC)                                                                                                 | `~/.codex/config.toml` (TOML)                                                               | `settings.json` (system, user, project)                        |
| MCP                 | `~/.copilot/mcp-config.json`                                                                                                       | `[mcp_servers.<id>]` in `config.toml`                                                       | `mcpServers` in `settings.json`                                |
| Usage               | Per call: input, output, cache read and write, reasoning, cost, quota                                                              | Input, cached input, output, reasoning, rate limit windows                                  | Prompt, candidates, cached, thoughts                           |
| Effort              | `--reasoning-effort`                                                                                                               | `model_reasoning_effort`                                                                    | None                                                           |

Two findings shape the design:

1. **ACP is a good common driver but not a common observer.** Copilot
   speaks the Agent Client Protocol natively and Codex and Claude have
   adapters. ACP covers start, prompt, stream, approve, cancel, resume and set
   mode. It cannot see sessions Overlord did not start and its usage data is
   thin. So we build one generic ACP runtime that any agent can use, use
   native drivers where they are much richer, and write a native observer per
   agent.
2. **Gemini is out of scope.** Google is moving consumer accounts from
   Gemini CLI to Antigravity CLI (`agy`), which reportedly has no ACP or JSON
   mode, so this plan skips both. The Gemini column above stays only for
   reference. If Gemini comes back later, it should be the generic ACP
   runtime (N1) plus a transcript reader, or a custom ACP agent (N4).
