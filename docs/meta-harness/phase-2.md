# Phase 2: new agents

<!-- cspell:words workstream workstreams -->

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
