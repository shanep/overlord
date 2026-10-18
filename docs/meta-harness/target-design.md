# Target design

<!-- cspell:words workstream workstreams -->

## Shared types (`src/shared/agents.ts`, new)

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

## Core adapter (`src/core/agents/`, new)

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

## Backends

The boisestate.ai bridge becomes a `Backend` with `appliesTo(agent)` and
`env(agent, port, token)`. It applies to Claude Code only at first. The
sidecar already speaks `/v1/chat/completions`, so Codex could use it later
through a `model_providers` override, but the bridge runs no tools, so that
only makes sense for chat runs. While touching it, fix the gap the audit
found: terminal tabs never call `resolveBridgeEnv`, so profiles with a
backend only work from the Launcher.

## Settings

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

## Editing Codex's config.toml

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
