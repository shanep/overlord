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
  starts, and its knobs catalog, library and sync part. The Knobs view has
  an agent pick and saves through each agent's own writer. Custom ACP
  agents (N4) have not started.
- **Phase 3** (help, README, PLAN.md, package.json) is this round.

Left: Copilot's subagent hooks, and N4.

## Sections

- [Background](docs/meta-harness/background.md): the connector check, the words this plan uses, where the code stood before the work, and what each other agent CLI offers
- [Target design](docs/meta-harness/target-design.md): the shared agent types, the core adapter facets, backends, settings and the targeted Codex TOML editor
- [Rules for every worker](docs/meta-harness/rules.md): how workers branch and land, which files each one owns, and why Phase 1 changes no behavior
- [Phase 0: contracts (lands first)](docs/meta-harness/phase-0.md): P0.1 contracts and the Claude adapter shell, P0.2 store merge fixes, P0.3 test safety and golden snapshots
- [Phase 1: put Claude behind the seams](docs/meta-harness/phase-1.md): workstreams A to H that move Claude Code behind the adapter facets
- [Phase 2: new agents](docs/meta-harness/phase-2.md): fixtures (N0), the ACP runtime (N1), Copilot (N2), Codex (N3) and custom ACP agents (N4)
- [Phase 3, order and decisions](docs/meta-harness/phase-3-order-decisions.md): the docs round, the order and parallelism chart, and the decisions made
- [Appendix A: inventory of Claude assumptions](docs/meta-harness/appendix-a-inventory.md): every place the code assumed Claude, file by file
- [Appendix B: sources](docs/meta-harness/appendix-b-sources.md): the docs and repos the research pass read
