# Phase 1: put Claude behind the seams

<!-- cspell:words workstream workstreams -->

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
