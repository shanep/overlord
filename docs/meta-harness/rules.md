# Rules for every worker

<!-- cspell:words workstream workstreams -->

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
   The table in [What the other agents give us](background.md#what-the-other-agents-give-us) is a snapshot and some of it came from third parties.
