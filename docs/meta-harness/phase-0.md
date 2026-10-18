# Phase 0: contracts (lands first)

Three workers in parallel. P0.1 is the only thing that blocks Phase 1, so
keep it small: types, a registry, and a Claude adapter that wraps existing
code with no behavior change.

## P0.1 Contracts and the Claude adapter shell

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

## P0.2 Store merge fixes

- **Owns:** `src/core/store/store.ts` and its tests.
- **Does:** key requests by `(sessionId, requestId ?? messageId)` and fold a
  transcript `msg_` id and an OTel `req_` id for the same call into one
  record. Merge `agent.upserted` field by field so a hook node never wipes
  usage, parent or depth that the transcript already set. Add tests that
  reproduce both bugs first.
- **Done when:** both bugs have failing tests that now pass.

## P0.3 Test safety and golden snapshots

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
