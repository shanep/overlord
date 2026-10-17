# Meta Harness Plan

<!-- cspell:words workstream workstreams -->

Overlord grew up as htop for Claude Code. This plan turns it into a meta
harness: one place to launch, watch, approve and tune any agent CLI (Claude
Code, Copilot CLI, Codex CLI, and anything that speaks ACP),
with Claude Code as the first adapter instead of the whole program.

The plan is split so many sessions can work on it at once. Phase 0 is small
and lands first because it owns every shared type. After that each workstream
owns its own files, and the new agents are written in their own directories.

## Status

Checked against `git log` on 2026-10-17.

- **Phase 0** has landed: the contracts and Claude adapter shell (P0.1), the
  store merge fixes (P0.2), and the test guards and golden snapshots (P0.3).
- **Phase 1** has landed except E4 and E5, which are in progress: the
  Launcher runs through the runtime facet (A), every `claude` argv sits
  behind the terminal facet (B), transcripts are watched through observers
  (C), hooks, telemetry and injection are facets (D), instructions resolve
  from each agent's policy (E1), knobs keep one catalog per agent and Codex
  gets the targeted TOML editor (E2), MCP servers are read from each agent's
  files (E3), models, health, tuning and reputation go through the adapter
  (F), the views hide what an agent cannot do (G), and the boisestate.ai
  bridge is a `Backend` (H).
- **Phase 2**: fixtures for Codex 0.163.0 and Copilot 1.0.89 (N0) and the
  generic ACP runtime (N1) have landed. Copilot (N2) has milestones 1 to 5:
  the Fleet, terminal tabs, Launcher runs over ACP, hooks, and the context
  view, knobs catalog and MCP add. Its subagent hooks and a live check of
  `additionalContext` are still open. Codex (N3) has milestones 1 to 5:
  the Fleet, terminal tabs, Launcher runs over app-server, hooks in
  `hooks.json` (once the user trusts them in `/hooks`), its notes as
  `developer_instructions` and OTel as `-c otel.*` for the sessions Overlord
  starts, and its knobs catalog, library and sync part. The Knobs view still
  shows Claude Code's knobs alone for both agents. Custom ACP agents (N4)
  have not started.
- **Phase 3** (help, README, PLAN.md, package.json) is this round.

Left: an agent pick in the Knobs view, Copilot's subagent hooks, and N4.

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

Appendix A has the full inventory, file by file.

## What the other agents give us

From the research pass on 2026-10-16. Sources are in Appendix B. Each
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

## Target design

### Shared types (`src/shared/agents.ts`, new)

```ts
/** Known ids get constants; custom ACP agents use their own string. */
export type AgentId = string;
export const CLAUDE_CODE: AgentId = 'claude-code';
export const CODEX: AgentId = 'codex';
export const COPILOT: AgentId = 'copilot';

export interface ModeOption {
  readonly id: string; // what we pass to the agent
  readonly label: string; // what the UI shows
  readonly risky?: boolean; // yolo, bypass, danger-full-access
}

/** What the UI may offer for sessions of this agent. */
export interface AgentCapabilities {
  readonly launch: boolean; // Launcher can run it programmatically
  readonly terminal: boolean; // can open it in a tab
  readonly background: boolean; // detached runs (claude --bg)
  readonly resume: boolean;
  readonly fork: boolean;
  readonly interrupt: boolean;
  readonly liveModelChange: boolean;
  readonly livePermissionMode: boolean;
  readonly approvals: boolean; // permission inbox works
  readonly subagents: boolean;
  readonly cacheReads: boolean;
  readonly cacheWrites: boolean;
  readonly costUsd: boolean; // agent or price table gives dollars
  readonly contextInspector: boolean;
  readonly hooks: boolean; // coordination and notes reach it
  readonly messaging: boolean; // cross-session messages
  readonly handoffs: readonly string[]; // Claude: desktop, teleport, ...
}

/** Sent to the webview once per state update. */
export interface AgentInfo {
  readonly id: AgentId;
  readonly name: string; // "Claude Code", "Codex CLI"
  readonly short: string; // "Claude", "Codex", used in "Continue in Codex"
  readonly icon: string; // codicon id
  readonly installed: boolean;
  readonly version: string | null;
  readonly capabilities: AgentCapabilities;
  readonly permissionModes: readonly ModeOption[];
  readonly effortLevels: readonly ModeOption[];
}
```

Changes to existing shared types, all made in Phase 0 so no later workstream
has to touch these files for types:

- `SessionSummary.agent: AgentId`, `SurfaceSession.agent`,
  `PermissionRequest.agent`, `LaunchProfile.agent` (default `claude-code`
  when missing, so saved profiles keep working).
- `LaunchProfile.backend?: string` (`'boisestate'` today). The
  `ANTHROPIC_BASE_URL=overlord://boisestate` placeholder keeps working and is
  read as `backend: 'boisestate'`.
- `permissionMode` keeps its name but its type widens to `string`. Each agent
  supplies its own `ModeOption` list. Renaming it would touch about 40 files
  for no gain.
- `Surface` keeps its values. Non-Claude sessions use the generic ones
  (`cli`, `sdk`, `overlord`). The Claude-only values (`desktop-code`,
  `cowork`, `cloud`, `claude-ai`) are only ever set by the Claude adapter.
- `PermissionRequest.source` gains `'runtime'` (any programmatic driver) next
  to `'sdk'` and `'hook'`.
- `RateLimits` gains `windows: { label, usedPct, resetsAt }[]`. The old
  `fiveHourPct` and `sevenDayPct` stay until the UI moves over.
- `FleetState` (or the shared state envelope) gains `agents: AgentInfo[]`.
- Protocol action `newSession { agent?: AgentId, ... }` next to the existing
  ones. `setModel` and `setPermissionMode` take string ids.

### Core adapter (`src/core/agents/`, new)

```ts
export interface AgentAdapter {
  readonly id: AgentId;
  readonly name: string;
  readonly short: string;
  detect(env: ShellEnv): Promise<{ bin: string | null; version: string | null }>;
  readonly capabilities: AgentCapabilities;
  readonly modes: { permission: readonly ModeOption[]; effort: readonly ModeOption[] };
  readonly models: ModelFacet; // context window, prices, default model
  readonly runtime?: RuntimeFacet; // Launcher, programmatic
  readonly terminal?: TerminalFacet; // tabs, background, stop
  readonly observer?: ObserverFacet; // sessions it did not start
  readonly hooks?: HooksFacet; // install, normalize, answer
  readonly telemetry?: TelemetryFacet; // OTLP env or config, decoder
  readonly inject?: InjectFacet; // how Overlord's notes reach it
  readonly instructions?: InstructionPolicy; // what the context view resolves
  readonly config?: ConfigFacet; // settings layers, knobs, MCP, skills
}
```

`src/core/agents/registry.ts` holds the adapters. `src/core/agents/index.ts`
registers them, one import and one line per agent, so adding an agent is an
append that never conflicts.

The facets, in the shape the current code needs:

- **RuntimeFacet**: `start(o: StartOptions): AgentRun`. `AgentRun` is an
  `AsyncIterable<AgentEvent>` with `send`, `endInput`, `interrupt`, `stop`,
  and optional `setModel`, `setPermissionMode`, `contextUsage`. `StartOptions`
  is today's `QueryOptions` with neutral names (cwd, sessionId, resumeId,
  fork, env, model, effort, permissionMode, extraArgs, budget, chatPrompt,
  `canUseTool`). The harness audit's sketch is the starting point.
- **AgentEvent**: a small neutral union (`init`, `message` with text,
  thinking and tool_use blocks plus usage, `tool_result`,
  `subagent_started`, `subagent_ended`, `compacted`, `rate_limit`,
  `turn_result`). One shared reducer, today's `MessageMapper` minus its SDK
  parsing, folds these into bus events. Each runtime only translates its
  wire format into `AgentEvent`.
- **TerminalFacet**: `newArgs`, `resumeArgs(id, fork)`, optional
  `background { start, attachArgs, list, stop }`, `interruptSignal`,
  `findLive(sessionId)`, and `tabName`. Claude fills all of it. The others
  start with new and resume.
- **ObserverFacet**: `scan()`, `childFiles()`, `makeAccumulator()`,
  `liveProcesses?()`, `digest?()`, `userPrompts?()` (for Reputation). A
  generic `TailingWatcher` built from `transcripts/watcher.ts` and
  `IncrementalReader` runs any observer.
- **HooksFacet**: `install(cmd)`, `uninstall()`, `normalize(raw):
NormalizedHookEvent`, `answer(event, decision | context): unknown`, and
  `editTools` (the tool names and input fields the coordinator watches). The
  relay binary gets an `--agent <id>` argument so one socket serves all of
  them.
- **TelemetryFacet**: `enable(port)` writes env or config, `decode(signal,
body)` returns `ApiRequest[]`. `otel/receiver.ts` and `otlp.ts` are shared.
- **InjectFacet**: how coordination notes, the launch check and the
  connector briefing reach a session. Order of preference: hook output
  (Claude, and Codex or Copilot where their hooks allow it), then a
  launch argument (`--append-system-prompt`, `-c developer_instructions=`),
  then a prefix on the first ACP prompt.
- **InstructionPolicy**: file names per directory, walk direction, byte cap,
  precedence, imports syntax, glob rule format, and the gate list. Claude's
  `context/gates.ts` and the spec tables in `context/candidates.ts` become
  the Claude policy. The walk, globs, imports and scan engine stay shared.
- **ConfigFacet**: settings layers with file format (JSON, JSONC, TOML) and
  precedence, a knob catalog, an MCP store (read the file directly, add
  through the agent's CLI when it has one), skill and agent folders with
  their frontmatter schemas. TOML files follow the rule in the next section.
- **ModelFacet**: `contextWindow(model, observed?)`, `price(model)`,
  `defaultModel`. Replaces the `claude-*` regex in `shared/model.ts:44` and
  the Anthropic-only table in `transcripts/pricing.ts`.

### Backends

The boisestate.ai bridge becomes a `Backend` with `appliesTo(agent)` and
`env(agent, port, token)`. It applies to Claude Code only at first. The
sidecar already speaks `/v1/chat/completions`, so Codex could use it later
through a `model_providers` override, but the bridge runs no tools, so that
only makes sense for chat runs. While touching it, fix the gap the audit
found: terminal tabs never call `resolveBridgeEnv`, so profiles with a
backend only work from the Launcher.

### Settings

- Keep `overlord.claudePath` so nobody's setup breaks.
- Add `overlord.agents`: an object keyed by agent id with `path` and
  `enabled`. `claudePath` wins over `agents["claude-code"].path` when set.
- Add `overlord.customAgents`: a list of `{ id, name, command, args }` for
  any ACP agent the user wants to bring. This is what makes Overlord a meta
  harness instead of a fixed list. It cannot be `overlord.agents.custom`,
  since VS Code cannot hold a setting under a name that is already an object
  setting.
- Keep every command id (`overlord.newClaudeSession`,
  `overlord.importClaudeAi`) because people bind keys to them. Add
  `overlord.newSession`, which asks which agent when more than one is
  installed. Change titles, not ids.

### Editing Codex's config.toml

Overlord never rewrites `~/.codex/config.toml` (or a project's
`.codex/config.toml`) as a whole. It only makes small, targeted edits that
keep everything else in the file byte for byte. Users keep comments and
section order in that file, and the Node TOML libraries drop or reorder
them on a round trip.

In order of preference:

1. **Launch overrides.** Settings for sessions Overlord starts go in as
   `codex -c key=value` from the launch profile. The file is not touched.
2. **Codex's own commands.** Use them where they exist (`codex mcp add`,
   `codex mcp remove`). Codex writes its own file.
3. **Separate files.** Hooks go in `~/.codex/hooks.json`, not a `[hooks]`
   table.
4. **Targeted edits.** For anything left, such as `[otel]` (Codex reads
   telemetry only from the user `config.toml`) or a knob saved from the
   Knobs view for terminal sessions, add or replace one key or one
   `[section]` block with a line-level edit.

The targeted editor lives in `src/core/knobs/toml-edit.ts` (owned by E2)
and works like the JSON writer in `knobs/write.ts`:

- It parses the file with `smol-toml` first to find the key or section and
  to refuse a file that does not parse.
- It changes only the lines of that key or block and leaves every other
  byte alone, comments included.
- It writes a `.bak` copy and swaps the file in atomically
  (`knobs/atomic-file.ts`).
- It parses the result again and checks that only the intended key changed,
  and puts the backup back if anything else moved.
- It refuses keys inside inline tables or arrays of tables. Those get shown
  as read-only with a "set it with `-c` or edit the file" note.

Tests run it over real `config.toml` files with comments, blank lines,
dotted keys and quoted keys, and assert that the diff is only the edited
lines.

## Rules for every worker

1. Work in your own worktree, as always. Rebase on `origin/master` before
   you start, and land with `npm run land` as the repo's CLAUDE.md says. It
   reviews the change, takes the land lock, rebases and pushes, so do not
   push by hand.
2. **Phase 1 changes no behavior.** Claude sessions must look the same in
   every view before and after. The existing tests stay green with only type
   edits. Workstream P0.3 adds golden snapshots of the fleet, agent and
   properties state built from fixtures, and Phase 1 keeps them identical.
3. **Do not move files in Phase 1.** Wrap the Claude modules where they sit
   and have `src/core/agents/claude/` import them. Moving 60 files at once
   would conflict with every other session in this repo. A later cleanup can
   move them.
4. **Stay in the files you own.** Each workstream lists what it owns. If you
   must touch a file another workstream owns, keep it to a few lines and say
   so in the commit message.
5. **Hot files** take small, append-only edits: `package.json`,
   `src/core/app/app.ts`, `src/core/app/actions.ts`,
   `src/core/agents/index.ts`, `cspell.json`, `README.md`. Phase 0 owns
   `src/shared/model.ts` and `src/shared/protocol.ts`. After Phase 0 lands,
   type changes there need a note in the commit. `npm run land` rebases
   right before it pushes.
6. **Never let a test start a real agent.** Phase 0 extends the guard in
   `test/unit-setup.ts` to `codex`, `gemini`, `copilot` and their keys and
   homes. Every adapter gets a fake binary under `test/fake-agents/<id>/`
   that replays recorded streams.
7. Run only the related tests and `typecheck:fast` while you work. The git
   hooks are the checks.
8. Check what your agent's CLI does today before you code against this plan.
   The table above is a snapshot and some of it came from third parties.

## Phase 0: contracts (lands first)

Three workers in parallel. P0.1 is the only thing that blocks Phase 1, so
keep it small: types, a registry, and a Claude adapter that wraps existing
code with no behavior change.

### P0.1 Contracts and the Claude adapter shell

- **Owns:** `src/shared/agents.ts` (new), `src/shared/model.ts`,
  `src/shared/protocol.ts`, `src/core/agents/types.ts`,
  `src/core/agents/registry.ts`, `src/core/agents/index.ts`,
  `src/core/agents/claude/index.ts` (all new except the two shared files).
- **Does:** every shared type change listed under Target design. Producers
  set `agent: 'claude-code'` (transcript accumulator, hook mapping, harness
  nodes, surfaces). The Claude adapter fills `capabilities`, `modes` and
  `models` by pointing at existing code, and leaves the other facets for
  Phase 1. The host sends `agents: AgentInfo[]` to the webview.
- **Done when:** typecheck and tests pass, the webview receives `agents`,
  and no view changes.

### P0.2 Store merge fixes

- **Owns:** `src/core/store/store.ts` and its tests.
- **Does:** key requests by `(sessionId, requestId ?? messageId)` and fold a
  transcript `msg_` id and an OTel `req_` id for the same call into one
  record. Merge `agent.upserted` field by field so a hook node never wipes
  usage, parent or depth that the transcript already set. Add tests that
  reproduce both bugs first.
- **Done when:** both bugs have failing tests that now pass.

### P0.3 Test safety and golden snapshots

- **Owns:** `test/unit-setup.ts`, `test/unit/no-real-api.test.ts`,
  `test/fake-agents/` (new), `test/golden/` (new).
- **Does:** block spawning `codex`, `gemini`, `copilot`, `agy` and `npx`
  forms of them in tests, and clear `OPENAI_API_KEY`, `CODEX_HOME`,
  `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_CLI_HOME`, `GH_TOKEN`,
  `GITHUB_TOKEN`, `COPILOT_*`. Point each agent's home at a temp dir. Write
  golden tests that build fleet, agent detail and properties state from the
  existing Claude fixtures and compare against checked-in JSON.
- **Done when:** a test that tries to spawn any of these fails loudly, and
  the golden files exist.

## Phase 1: put Claude behind the seams

Starts when P0.1 lands. All workstreams run in parallel. Each one moves one
area of Claude code behind a facet, wires the area to use the registry, and
keeps the golden snapshots identical.

| Id  | Workstream                         | Owns                                                                                                                                                                                                                                                     | Facet                    |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| A   | Runtime and Launcher               | `src/core/harness/*`, `src/core/agents/claude/runtime.ts`, `src/core/agents/shared/reducer.ts`                                                                                                                                                           | runtime                  |
| B   | Terminal lifecycle                 | `app/claude-bin.ts`, `claude-tabs.ts`, `idle-stop.ts`, `jobs.ts`, `relocate.ts`, `actions-session.ts`, `places.ts`, `surfaces/live.ts`, `surfaces/jobs.ts`, `surfaces/handoff.ts`, `surfaces/places.ts`, `host/cli-tabs.ts`, `agents/claude/terminal.ts` | terminal                 |
| C   | Observation                        | `src/core/transcripts/watcher.ts`, `app/sources.ts`, `surfaces/sessions.ts`, `agents/shared/tailing-watcher.ts`, `agents/claude/observer.ts`                                                                                                             | observer                 |
| D   | Hooks, telemetry, injection        | `src/core/hooks/*`, `src/hook/*`, `src/core/otel/*`, `coordination/coordinator.ts`, `connectors/briefing.ts`, `app/setup.ts`, `agents/claude/{hooks,telemetry,inject}.ts`                                                                                | hooks, telemetry, inject |
| E1  | Instructions                       | `src/core/context/*`, `src/core/launch-check/*`, `agents/claude/instructions.ts`                                                                                                                                                                         | instructions             |
| E2  | Knobs and profiles                 | `src/core/knobs/*`, `scripts/generate-catalog.mjs`, `app/settings-view.ts`, `app/actions-config.ts`, `agents/claude/config.ts` (knobs part)                                                                                                              | config                   |
| E3  | MCP and connectors                 | `src/core/connectors/*` except `briefing.ts`, `app/actions-connectors.ts`, `app/views/connectors-data.ts`, `src/shared/connectors.ts`                                                                                                                    | config (MCP)             |
| E4  | Authoring and skills               | `src/core/authoring/*`, `app/authoring.ts`, `app/actions-authoring.ts`, `app/transfer.ts`, `context/skills.ts`                                                                                                                                           | config (skills, agents)  |
| E5  | Config sync                        | `src/core/sync/*`, `app/sync-commands.ts`, `app/adopt.ts`, `app/memory.ts`                                                                                                                                                                               | config (sync)            |
| F   | Models, health, tuning, reputation | `transcripts/pricing.ts`, `app/prices.ts`, `src/core/health/*`, `src/core/tuning/*`, `src/core/reputation/*`, `src/shared/tuning.ts`, `src/shared/health.ts`                                                                                             | models                   |
| G   | UI by capability                   | `webview/src/**`, `src/core/app/views/*`                                                                                                                                                                                                                 | (reads `AgentInfo`)      |
| H   | Backends                           | `src/core/bridge/*`, `src/host/boisestate-bridge.ts`, the bridge parts of `harness/launcher.ts`                                                                                                                                                          | backend                  |

Notes per workstream:

- **A.** Split `mapper.ts` into the Claude translator (SDK JSON to
  `AgentEvent`) and the shared reducer (`AgentEvent` to bus events). Rename
  `SdkSession` to `AgentSession` around `AgentRun`. `Launcher.runSession`
  picks the runtime from `profile.agent`. `sdk-types.ts` becomes the body of
  `agents/claude/runtime.ts`. `test/fake-claude` keeps working.
- **B.** The Claude terminal facet takes over every `claude` argv in the
  list. `actions-session.ts` asks the session's adapter what it can do
  instead of checking `SDK_ONLY`. `worktrees.ts` `startSession` calls the
  adapter's terminal facet (one small edit there, coordinate with E1 if both
  touch it). Tab names come from `adapter.short`. Apply profile backends to
  tabs (with H).
- **C.** Pull the tail and poll loop out of `watcher.ts` into a generic
  `TailingWatcher` that takes an observer. `Sources` iterates every enabled
  adapter's observer. Fold the duplicate `surfaceForEntrypoint` rules in
  `surfaces/sessions.ts` and `accumulator.ts` into the Claude observer. The
  Claude parsers stay where they are.
- **D.** `NormalizedHookEvent` covers session start, prompt submit, pre and
  post tool use, permission request, subagent start and stop, stop and
  compaction. The server picks a normalizer by the relay's `--agent` value.
  The coordinator gets edit tool names from `hooks.editTools`. Move the hook
  socket and the `loaded.json` marker out of `~/.claude/overlord/` into
  `~/.overlord/`, and update `scripts/install-local.mjs` (it waits on that
  marker) in the same commit, or the install-overlord skill breaks.
- **E1.** `context/` keeps the walk, glob, import and scan engine and takes
  an `InstructionPolicy`. `gates.ts` and the candidate tables become the
  Claude policy. `launch-check/instructions.ts` scans the files the session's
  agent reads (it misses `AGENTS.md` today even for Claude). `probe.ts`
  keeps checking `~/.claude/shims`, since those are machine-wide.
- **E2.** One catalog per agent: `catalog.generated.json` becomes
  `catalogs/claude-code.json` and `generate-catalog.mjs` takes per-agent
  sources and parsers. Layers and precedence come from the facet. E2 owns
  `knobs/toml-edit.ts` and the TOML rule under Target design: launch
  profiles set Codex knobs with `-c key=value`, and saving a knob for
  terminal sessions goes through the targeted editor. Build the editor early,
  since D and N3 need it for `[otel]`. The profile schema validates `permissionMode` and `effort` against the
  chosen agent's lists.
- **E3.** List servers by reading each agent's MCP file directly instead of
  scraping `claude mcp list`. Add through the agent's own CLI where it has
  one (`claude mcp add-json`, `codex mcp add`), and write
  the JSON file directly for Copilot. The `'claude.ai'` connector kind and
  Claude in Chrome stay Claude-only. The registry browser offers "add to"
  with a pick of agents.
- **E4.** Skills are spreading as `SKILL.md`. Copilot reads `.claude/skills`
  and `.github/skills`, Codex reads `.agents/skills`. Keep one
  skill schema and let each agent list its folders. Agent definitions
  differ per agent (Copilot uses `.github/agents/*.agent.md`), so the agent
  schema becomes per adapter. The `/overlord` transfer skill installs into
  every installed agent that reads skills.
- **E5.** Lowest priority. Namespace the config repo by agent: keep
  `global/` as Claude so existing repos still apply, add `agents/<id>/` for
  the rest. Applying synced Codex settings goes key by key through
  `knobs/toml-edit.ts`. Sync never copies a whole `config.toml` over the
  user's file.
- **F.** `contextWindow` and pricing move to each adapter's model facet, with
  the shared function calling the right one. Health, tuning and the Fleet
  show a dash, not 0%, when `cacheReads` is false, and a dash for cost when
  `costUsd` is false. Advice text uses the adapter's words (instruction file
  name, compact command). `FrustrationTarget = 'claude'` becomes `'agent'`.
  Reputation reads prompts through `observer.userPrompts()`.
- **G.** Add an agent badge to Fleet rows and an agent filter. Gate effort,
  permission mode, cache, subagents, context inspector sections, handoffs,
  claude.ai import, feature flags and plan limits on capabilities. Replace
  hard-coded "Claude" in `agent-feed.tsx:50`, `properties-view.tsx`,
  `agent-header.tsx`, `launcher-view.tsx`, `fleet-actions.ts` and the
  connector views with `AgentInfo.name` or `short`. Add the agent pick to the
  Launcher and the sparkle. Help text moves in Phase 3.
- **H.** Wait for the session that is changing `bridge/boisestate.ts` and
  the proxy right now (branch `overlord/f6083c18-...`) to land first. Then
  make `Backend` an interface and keep boisestate.ai as its only member.

## Phase 2: new agents

These start right after P0.1, not after Phase 1. Each agent worker writes
the parts that need no seam first: pure translators and parsers with
fixtures, checked against the `AgentEvent`, `NormalizedHookEvent` and bus
types. Each part plugs in as its Phase 1 seam lands.

| Id  | Workstream          | Owns                                                     | Needs                            |
| --- | ------------------- | -------------------------------------------------------- | -------------------------------- |
| N0  | Fixture capture     | `test/fixtures/<agent>/`                                 | The CLIs installed and signed in |
| N1  | Generic ACP runtime | `src/core/agents/acp/*`                                  | A for plug-in                    |
| N2  | Copilot CLI         | `src/core/agents/copilot/*`, `test/fake-agents/copilot/` | N0, then A, B, C, D, E1, E3      |
| N3  | Codex CLI           | `src/core/agents/codex/*`, `test/fake-agents/codex/`     | N0, then A, B, C, D, E1, E2, E3  |
| N4  | Custom ACP agents   | `agents/custom.ts`, the `overlord.customAgents` setting  | N1, G                            |

Each agent lands in milestones, and each milestone is a separate commit
that ships on its own:

1. **See it.** Detect the binary and version, read its transcripts, and show
   its sessions in the Fleet with the agent badge. Tokens, model, tool calls
   and the feed work. Cost shows when the agent or a price table gives it.
2. **Start it.** New session and resume in a terminal tab, from the sparkle
   and the Fleet.
3. **Drive it.** Launcher runs through the runtime, with the permission
   inbox, interrupt and the kill switch. Matrix runs can mix agents.
4. **Talk to it.** Hooks installed (with the same opt-in prompt Claude
   gets), so coordination notes, the launch check, the connector briefing
   and edit conflict blocks reach it. OTel when it adds anything the
   transcripts lack.
5. **Tune it.** Context view with its instruction files, MCP list and add,
   knobs from its catalog, skills.

Per agent notes:

- **N0.** Copilot is installed here, so its fixtures come first. Codex
  installs with `npm i -g @openai/codex` (or into a scratch prefix). Signing
  in to Codex is the one manual step, since it opens a browser login that
  only Shane can finish. Record a short scripted session per agent (one prompt, one shell
  tool call, one file edit, one denied approval) and save the transcript,
  the stream output, hook payloads and OTel bodies. Scrub tokens, emails and
  home paths before committing.
- **N1.** One ACP client over stdio: `initialize`, `session/new`,
  `session/load` or `session/resume`, `session/prompt`, streamed updates,
  `request_permission` into the inbox, `cancel`, `set_mode`, and
  `usage_update`. Translate updates into `AgentEvent`. Unit test it against
  a fake ACP agent. This also gives Claude and Codex a second driver through
  their ACP adapters, which is a good cross-check.
- **N2 Copilot.** The runtime uses `@github/copilot-sdk` (it handles
  approvals, abort, resume and models), with N1 as a fallback. The observer
  reads `~/.copilot/session-state/<uuid>/events.jsonl` and should validate
  against `schemas/session-events.schema.json` from the installed package,
  with a "format not verified" badge outside the tested versions (the same
  rule PLAN.md sets for Claude files). `--session-id` lets Overlord pick the
  id up front like it does for Claude. Copilot also reads `CLAUDE.md` and
  `.claude/skills`, so its instruction policy must list them, or the context
  view will say they did not load when they did.
- **N3 Codex.** The runtime drives `codex app-server` over JSON-RPC, not the
  TypeScript SDK, because only app-server answers approvals, interrupts a
  turn and reports rate limits. The observer reads rollout files, which are
  undocumented, so it needs the version badge too. Codex mints its own
  thread id, so the runtime reports the id after `thread.started` and the
  Fleet must accept a session whose id arrives late. Config is TOML and
  follows the rule under Target design: profile settings as `-c` overrides,
  MCP through `codex mcp add`, hooks in `~/.codex/hooks.json`, and only the
  `[otel]` block through the targeted editor.
- **N4.** Any command that speaks ACP becomes an agent with milestone 3
  only: launch, drive, approve. No observer, hooks or config. This is the
  "add any agent" path.

## Phase 3: words and docs

Starts after G and at least one new agent reach milestone 2.

- **Help** (`webview/src/views/help-*.ts(x)`): the Claude lifecycle text
  (`claude --bg`, `attach`, `agents`, `stop`) becomes the Claude section of
  per-agent help, driven by capabilities.
- **README.md and PLAN.md**: describe Overlord as a meta harness with Claude
  Code as one adapter. PLAN.md's data source table gets a column per agent.
- **package.json**: description and keywords, command titles ("New Claude
  Code Session" stays as a command, next to "New Session..."), setting
  descriptions that say "your Claude settings".
- **cspell.json**: the new agent words.

## Order and parallelism at a glance

```text
Phase 0   P0.1 contracts --+   P0.2 store   P0.3 tests
                           |
Phase 1                    +-- A  B  C  D  E1  E2  E3  E4  E5  F  G  H   (12 in parallel)
                           |
Phase 2                    +-- N0 fixtures --+-- N2 Copilot  (parsers now, plug in as seams land)
                           |                 +-- N3 Codex
                           +-- N1 ACP -------+-- N4 custom ACP
                           |
Phase 3                    +-- help, README, PLAN.md, package.json (after G and one agent at M2)
```

The longest chain is P0.1, then A and C, then N2 milestone 3. Everything
else can run beside it. A sensible first wave is P0.1, P0.2, P0.3 and N0.
The second wave is all of Phase 1 plus N1 and the parser halves of N2 and
N3.

## Decisions

Decided with Shane on 2026-10-16. Nothing is open.

1. **Gemini is out.** No Gemini CLI or Antigravity CLI adapter. Anyone who
   wants it later can add it as a custom ACP agent (N4).
2. **Copilot first, then Codex.** Copilot is installed and ships its own
   event schema.
3. **`config.toml` gets targeted edits only**, never a full rewrite (see
   "Editing Codex's config.toml").

## Appendix A: inventory of Claude assumptions

Kinds: **a** Claude only, goes behind the Claude adapter. **b** generic logic
with Claude paths or names, takes a facet. **c** already generic.

| Area                | Files                                                                                                                                                                                                                  | Kind                | Workstream                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------- |
| SDK port            | `harness/sdk-types.ts` (`toSdkOptions`, `sdkPlanUsage`), `harness/messages.ts`                                                                                                                                         | a                   | A                                 |
| Session lifecycle   | `harness/session.ts`, `options.ts` (`toSdkPermissionMode`, `effortSchema`, `mergeEnv`)                                                                                                                                 | b                   | A                                 |
| Event mapping       | `harness/mapper.ts` (SDK `init`, `task_started`, `compact_boundary`, `rate_limit_event`)                                                                                                                               | a input, c output   | A                                 |
| Launcher            | `harness/launcher.ts` (bin path, bridge prompt), `nodes.ts` (`surface: 'overlord'`, 5h and 7d limits), `events.ts`                                                                                                     | b                   | A, H                              |
| Already neutral     | `harness/inbox.ts`, `input-queue.ts`, `matrix.ts`, `estimate.ts`, `app/permissions.ts`, `app/process.ts`                                                                                                               | c                   | none                              |
| Claude binary       | `app/claude-bin.ts`, `host/host-port.ts:42` (`resolveClaude`), `OverlordSettings.claudePath`                                                                                                                           | a                   | B                                 |
| Tabs and background | `app/claude-tabs.ts`, `idle-stop.ts`, `jobs.ts`, `relocate.ts`, `actions-session.ts` (`SDK_ONLY`, `claude stop`, tab names), `places.ts`, `worktrees.ts` (`openClaudeTab`)                                             | a                   | B                                 |
| Session registry    | `surfaces/live.ts` (`~/.claude/sessions/<pid>.json`, `claude agents --json`), `surfaces/jobs.ts`, `surfaces/places.ts`                                                                                                 | a                   | B                                 |
| Handoffs            | `surfaces/handoff.ts`, `HandoffKind` in `protocol.ts:194`                                                                                                                                                              | a                   | B, G                              |
| Transcripts         | `transcripts/scanner.ts`, `schemas.ts`, `thread.ts`, `accumulator.ts`, `subagents.ts`, `context.ts`, `digest.ts`, `peek.ts`, `text.ts`                                                                                 | a                   | C                                 |
| Tailing             | `transcripts/reader.ts`, the loop in `watcher.ts`                                                                                                                                                                      | c                   | C                                 |
| Other surfaces      | `surfaces/desktop.ts`, `cowork.ts`, `local-session-files.ts`, `claude-ai-export.ts`, `usage.ts` (`stats-cache.json`), `plan-limits.ts`                                                                                 | a                   | C                                 |
| Surface list        | `surfaces/sessions.ts` (`ExtraSource`, `SURFACE_RANK`)                                                                                                                                                                 | b                   | C                                 |
| Paths               | `core/paths.ts` (`ClaudePaths`, `encodeProjectDir`)                                                                                                                                                                    | a                   | every Claude facet                |
| Hooks               | `hooks/install.ts`, `payloads.ts`, `mapping.ts`, `rules.ts`                                                                                                                                                            | a                   | D                                 |
| Hook transport      | `hooks/protocol.ts`, `server.ts`, `socket-path.ts`, `audit.ts`, `src/hook/*`                                                                                                                                           | c, b for socket dir | D                                 |
| OTel                | `otel/env.ts`, `decode.ts` (`claude_code.*`)                                                                                                                                                                           | a                   | D                                 |
| OTel transport      | `otel/otlp.ts`, `receiver.ts`                                                                                                                                                                                          | c                   | D                                 |
| Coordination        | `coordination/coordinator.ts` (edit tool names, `file_path`), `workspaces.ts` (`.claude/worktrees`)                                                                                                                    | b                   | D                                 |
| Coordination notes  | `coordination/notes.ts`, `connectors/briefing.ts` text                                                                                                                                                                 | c                   | D                                 |
| Instructions        | `context/gates.ts`, `candidates.ts`, `types.ts` (kinds), `resolve.ts` (auto memory), `memory.ts`, `skills.ts`                                                                                                          | a                   | E1, E4                            |
| Instruction engine  | `context/fs.ts`, `glob.ts`, `imports.ts`, `path-tools.ts`, `frontmatter.ts`, `snapshot.ts`                                                                                                                             | c                   | E1                                |
| Launch check        | `launch-check/instructions.ts`, `probe.ts`, `repo.ts`                                                                                                                                                                  | b                   | E1                                |
| Launch check engine | `launch-check/checker.ts`, `note.ts`                                                                                                                                                                                   | c                   | none                              |
| Knob catalog        | `knobs/catalog.generated.json`, `doc-parser.ts`, `areas.ts`, `scripts/generate-catalog.mjs`                                                                                                                            | a                   | E2                                |
| Settings layers     | `knobs/layers.ts`, `effective.ts`, `profiles.ts`, `write.ts`                                                                                                                                                           | b                   | E2                                |
| Feature flags       | `knobs/flags.ts` (`~/.claude.json` caches)                                                                                                                                                                             | a                   | E2                                |
| Settings views      | `app/settings-view.ts`, `actions-config.ts` (`layerFile`)                                                                                                                                                              | b                   | E2                                |
| MCP                 | `connectors/mcp-list.ts`, `install.ts`, `chrome.ts`, `check.ts`, `app/actions-connectors.ts`, `views/connectors-data.ts`                                                                                               | a                   | E3                                |
| MCP registry        | `connectors/registry.ts`, `registry-api.ts`, `stdio-mcp.ts`, `headless.ts`                                                                                                                                             | c                   | none                              |
| Authoring           | `authoring/schema.ts`, `draft-prompt.ts`, `write.ts`, `app/authoring.ts`, `actions-authoring.ts`, `app/transfer.ts`                                                                                                    | a, b for targets    | E4                                |
| Sync                | `sync/layout.ts`, `inventory.ts`, `inventory-sources.ts`, `denylist.ts`, `mcp.ts`, `plan.ts`, `apply.ts`, `memory-sync.ts`, `import-dotfiles.ts`, `settings-gen.ts`, `app/adopt.ts`, `memory.ts`, `sync-commands.ts`   | a, b                | E5                                |
| Sync engine         | `sync/secrets.ts`, `git.ts`, `github.ts`, `exec.ts`, `files.ts`, `actions.ts`, `manifest.ts`                                                                                                                           | c                   | none                              |
| Models and prices   | `shared/model.ts:44` (`contextWindow`), `transcripts/pricing.ts`, `app/prices.ts`                                                                                                                                      | a                   | F                                 |
| Health              | `health/health.ts` (cache signal, advice text), `shared/health.ts`                                                                                                                                                     | b                   | F                                 |
| Tuning              | `tuning/rules.ts`, `measure.ts`, `suggestions.ts`                                                                                                                                                                      | a text, c engine    | F                                 |
| Reputation          | `reputation/prompts.ts` (Claude records, `history.jsonl`), `detect.ts` (`'claude'` target)                                                                                                                             | a, b                | F                                 |
| Messaging           | `src/core/messaging/*` (`SendMessage`, Claude tags)                                                                                                                                                                    | a                   | Claude only, gated by `messaging` |
| Activity, store     | `activity/*`, `store/ring.ts`, `scoped.ts`, `sparkline.ts`, `store.ts`                                                                                                                                                 | c                   | P0.2 for store                    |
| View models         | `app/views/fleet.ts` (`surface: 'cli'`, registry), `sessions.ts`, `knobs.ts`, `usage.ts`, `config.ts`, `context-resolve.ts`, `tuning.ts`                                                                               | b                   | G with C, E2                      |
| Webview strings     | `agent-feed.tsx:50`, `properties-view.tsx:35,209,215`, `agent-header.tsx:110`, `fleet-actions.ts:32`, `launcher-view.tsx:25`, `messages-inbound.tsx`, `knobs-*.tsx`, `config-*.ts(x)`, `connectors-*.tsx`, `labels.ts` | a                   | G                                 |
| Webview help        | `help-content.ts`, `help-sessions.tsx`, `help-screen*.ts(x)`, `help-view.tsx`                                                                                                                                          | a                   | Phase 3                           |
| Webview gated UI    | effort, permission mode, cache, subagents, context inspector, handoffs, plan limits, feature flags                                                                                                                     | a                   | G                                 |
| Bridge              | `bridge/boisestate.ts`, `proxy/*`, `host/boisestate-bridge.ts`, `host/extension.ts` key command                                                                                                                        | b                   | H                                 |
| Host                | `host/extension.ts` (command ids), `host/cli-tabs.ts`, `host/host-port.ts`                                                                                                                                             | b                   | B, G                              |
| Packaging           | `package.json` (description, keywords, command titles, `claudePath`, setting text), `scripts/install-local.mjs` (`~/.claude/overlord/loaded.json`)                                                                     | b                   | D, Phase 3                        |
| Tests               | `test/unit-setup.ts`, `test/fake-claude/*`, transcript fixtures, webview tests that assert "Claude"                                                                                                                    | a                   | P0.3, each agent                  |
| Docs                | `README.md`, `PLAN.md`, `cspell.json`                                                                                                                                                                                  | a                   | Phase 3                           |

## Appendix B: sources

Checked 2026-10-16. Copilot details also come from the installed 1.0.89
package (`copilot --help`, `schemas/session-events.schema.json`).

- Codex: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
  [app-server](https://learn.chatgpt.com/docs/app-server),
  [SDK](https://learn.chatgpt.com/docs/codex-sdk),
  [hooks](https://learn.chatgpt.com/docs/hooks.md),
  [config reference](https://learn.chatgpt.com/docs/config-file/config-reference),
  [TypeScript SDK events](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts)
- Gemini: [headless mode](https://geminicli.com/docs/cli/headless/),
  [ACP mode](https://geminicli.com/docs/cli/acp-mode/),
  [session management](https://geminicli.com/docs/cli/session-management/),
  [hooks](https://geminicli.com/docs/hooks/),
  [telemetry](https://geminicli.com/docs/cli/telemetry/),
  [move to Antigravity CLI](https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- Copilot: [SDK](https://github.com/github/copilot-sdk),
  [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server),
  [hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference),
  [config directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference),
  [custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- ACP: [updates](https://agentclientprotocol.com/updates),
  [Codex adapter](https://github.com/zed-industries/codex-acp)
