# Milestones, risks and decisions

## Milestones

Each milestone ships something usable and keeps every quality gate green.

- **M0 Foundation (1 week)**: repo scaffold, all tooling and CI at max strict,
  fixture corpus, fake Claude binary. Verify the open questions: transcript
  format across the last few versions, `--cloud` and `--teleport` behavior,
  what Cowork accepts, `claude agents --json` fields.
- **M1 Observe (2 weeks)**: transcript tailer, session registry, subagent tree,
  Fleet view, Agent detail with the feed and token charts. Read-only.
- **M2 Context inspector (2 weeks)**: loaded items from transcripts, the
  "why not" resolver, hook receiver with `InstructionsLoaded`, `SubagentStart`
  and `SubagentStop`.
- **M3 Harness (3 weeks)**: SDK runner, launcher, batches, matrix runs,
  worktree isolation, permission inbox, live model and mode changes, budgets.
- **M4 Knobs (2 weeks)**: generated catalog, layer provenance, launch profiles,
  OTel receiver and timeline traces.
- **M5 Config and sync (3 weeks)**: inventory and badges, config repo, apply
  and diff, secrets, dot-files import, new machine bootstrap, agent and skill
  authoring.
- **M6 Sessions everywhere (2 weeks)**: Desktop Code tab and Cowork listing,
  cloud sessions, teleport and remote control actions, claude.ai export import.
- **M7 Polish (1 week)**: usage history, performance on the full 511 MB
  history, docs, `.vsix` on GitHub releases and the VS Code Marketplace.

That is about 16 weeks of focused work. M1 alone is a useful tool.

## Risks

- **Undocumented formats change.** Transcripts, the session registry and the
  Desktop files can change on any release. Contract tests and version-gated
  parsers catch it, and the UI degrades to "not verified" instead of lying.
- **Hooks touch your settings.** A bug in the hook script could slow every
  session. The script has a hard 200 ms budget, always exits 0, and Overlord
  can remove the block in one click.
- **Cost of matrix runs.** Caps are off by default, so the launcher shows a
  cost estimate before a batch starts and a live spend total while it runs.
- **Auto-approve rules.** A loose rule could approve something destructive.
  Rules are off until you write one, deny rules always win, and every
  auto-approval is logged with the rule that matched.
- **Memory in git.** Auto memory can hold project details you would not want
  shared. The config repo is private and the same secret scan runs on memory
  files.
- **Secrets in the config repo.** Denylist, placeholders, keychain, and a
  pre-commit scan.
- **claude.ai and Cowork handoff may not be possible** with supported
  surfaces. The plan treats those as view-first and only adds actions that
  use documented commands.
- **Electron and native modules.** We avoid native modules so one package
  works on macOS and Linux.

## Decisions

Made 2026-10-15.

1. Config repo: `shanep/overlord-config`, private.
2. Overlord repo: public, MIT license.
3. Distribution: `.vsix` on GitHub releases and the VS Code Marketplace.
4. Quality gates: 100% unit coverage and a 90% mutation score on `core/`, both
   hard gates.
5. Handoff: both Claude Code on the web (`--cloud`, `--teleport`) and Claude
   Desktop (`--desktop`).
6. Hooks and OTel: off until you turn them on in the setup screen.
7. Permissions: approve and deny from the UI, plus auto-approve rules.
8. Budgets: no caps by default. Spend is always shown.
9. Auto memory: synced for every project.
10. `shanep/dot-files/claude`: moved into `overlord-config`, with a pointer left
    in the dot-files README.
11. claude.ai chats: build the view-only export import.
12. Build order: as planned, M0 through M7.
13. Versions: current stable VS Code, Node 22, Claude Code 2.1.301 or newer.
14. Linux: everything except the Desktop and Cowork views, which are hidden
    there since Claude Desktop does not run on Linux.
