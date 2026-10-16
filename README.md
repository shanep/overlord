# Overlord

SkyNet version 1.0, let it begin.

Overlord is a VS Code extension that works like htop for Claude Code. It shows every running
session and subagent, what is in each one's context and why, and every knob you can turn. It
also runs agents itself, so you can launch a batch of prompts and watch them side by side.

See [PLAN.md](PLAN.md) for the full design and the decisions behind it.

## What it does

- **Claude Code in a tab**: **Overlord: New Claude Code Session** (or the sparkle button in the
  Overlord sidebar) starts a `claude` session in the background, in its own worktree of your
  workspace repo (see [Worktrees](#worktrees)), and attaches an editor tab to it. Closing the tab
  leaves the session running in the background instead of asking to terminate it, and clicking it in
  the Fleet attaches a new tab. Continue here works the same way. If Claude Code cannot start a
  background session, the tab runs `claude` itself, and with the official Claude Code extension
  installed it connects to VS Code on its own, so diffs open in the editor and Claude sees your
  selection.
- **Fleet**: every session, subagent and background task with live state, tokens, cost, cache
  hit ratio and the tool it is running right now. An icon shows where each session runs (a VS
  Code terminal, another terminal or the background). Click a session to jump to its terminal
  tab, or to attach a tab to a background session. Switch terminal tabs and the fleet highlights
  the session in the one you are on. Switch to another VS Code window and its fleet highlights
  the session that ran in that window's folder. Sessions are grouped by project. A git repo is a
  project on its own, and its worktrees count as the repo. A session in any other folder lands
  in Unassigned, and the window running it asks once whether to add it to a project, make a new
  one, or never ask about that folder again.
- **Agent detail**: the live feed of thinking and tool calls, a tool timeline, and token, cost
  and context charts.
- **Context inspector**: the system prompt, every memory file that loaded (and why), and every
  file that did not load (and why not).
- **Knobs**: 700+ settings, env vars and CLI flags pulled from the docs, with the effective value
  and which layer set it.
- **Launcher**: run many prompts at once, across profiles, each in its own git worktree, with one
  permission inbox and auto-approve rules. Always allow on a pending request writes the rule for
  you: the exact command for Bash, or the whole tool otherwise.
- **All sessions**: CLI, Claude Desktop, Cowork, cloud sessions and claude.ai chats in one list,
  with handoff between local and cloud.
- **Config and sync**: every config item with a badge for versioned, local only, external repo
  and so on, synced through a separate git repo so a new machine matches this one.
- **Usage**: daily tokens by model and activity by hour.
- **Tips**: advice from measuring every session transcript, such as how much of the spend goes
  to re-reading old context, sessions that never compact, huge tool output and denied tools.
  Each tip lists its pros and cons and when to skip it, since following one can mean giving up
  context a long session took hours to build. It also suggests skills and agents for work your
  sessions keep doing by hand, and **Create** writes one into `~/.claude` or the project.
- **Keep awake**: while Overlord is open the computer does not sleep, so agents keep working and
  the machine stays reachable remotely. The display still turns off. Turn it off with
  `overlord.keepAwake`.

## Install

Grab the `.vsix` from the GitHub releases page and install it:

```sh
code --install-extension overlord-0.1.0.vsix
```

Then open the Overlord icon in the activity bar. Run **Overlord: Set Up Hooks and Telemetry**
to get live permission requests, memory load events and per-request cost. Both are off until
you turn them on, since they write to `~/.claude/settings.json`.

**Help** under Global in the sidebar explains every icon and badge and walks through a
typical workflow.

## Worktrees

Every Claude session Overlord starts, from **New Claude Code Session** or the launcher, gets its
own git worktree, so many sessions can work in one repo without stepping on each other. Worktrees
live in `~/.overlord/worktrees`, outside the repo, on a branch `overlord/<id>` cut from a fresh
fetch of the default branch.

When a session ends, Overlord removes its worktree if everything in it landed. Anything left over
(uncommitted edits, or commits the default branch does not have) stays in the **Worktrees** table
in the launcher, where you can open a session in it, land it or discard it. Land rebases onto the
latest default branch and pushes. The table also flags worktrees that change the same files.

A new worktree has none of the repo's ignored files, so Overlord sets it up:

- Ignored files that match `.worktreeinclude` (gitignore syntax) are copied from the main checkout.
- `node_modules` is cloned from the main checkout when the lockfiles match. The clone is
  copy-on-write where the file system supports it, so it takes seconds. On macOS the whole tree
  clones in one call, so it takes about a second.
- `.overlord/setup.sh` runs in the worktree if the repo has one.

A new session's tab opens while setup runs, since you still have to type a prompt. A launched run
waits for setup to finish before it starts.

Each session also gets `OVERLORD_SLOT`, a small number no other live worktree has, and
`OVERLORD_PORT_BASE` (40000 plus 100 per slot), so dev servers and test databases can pick ports
that do not collide.

## New machine

1. Install the extension.
2. Run **Overlord: Set Up This Machine From Config Repo** and give it the repo URL.
3. Review the dry run, which lists every link and overwrite, and confirm.

Anything Overlord would overwrite is backed up to `~/.claude/backups/overlord-<timestamp>` first.

## Building

```sh
npm ci
npm run build
```

Press F5 in VS Code to run the extension in a development host.

To install the committed build into your own VS Code and reload onto it:

```sh
npm run install:local
```

It builds `HEAD` in a temporary worktree, installs the package, and waits
until a window reloads. Installed copies watch their own bundle and reload the
window when a new one lands, so there is no Reload Window to press. The first
install over a copy older than this needs one reload by hand.

## Testing

```sh
npm test                       # unit tests
npm run test:coverage          # unit tests with the 100% coverage gate
npm run test:mutation:changed  # Stryker on the files you changed, a minute or two
npm run test:mutation          # Stryker on everything, about 13 minutes
npm run test:integration       # runs the extension inside VS Code
npm run check                  # every gate except mutation testing
```

Mutation testing fails under a 90% score. Day to day, run the changed-files
version. It diffs against `origin/master` (or `MUTATION_BASE`) and keeps an
incremental cache, so a repeat run takes seconds. CI does the same on every
push, and the full sweep runs nightly.

`npm run check` runs typecheck, ESLint (zero warnings), Prettier, coverage, type coverage at
100%, knip, dependency-cruiser, cspell, markdownlint and the no-dashes check. CI runs it on every
push.

The git hooks only look at what changed, so they stay quick:

- pre-commit (a few seconds): typecheck, lint and format on staged files, and the tests
  related to them.
- pre-push (under 10 seconds for a small change): `npm run check:fast`, which runs the tests
  affected since `origin/master`.

Lint in the hooks uses a cache, so a type change in one file can hide an error in another
until CI's full lint catches it.

None of the tests call the Claude API. Sessions run against a fake Claude binary in
`test/fake-claude/` that replays scripted conversations through the real Agent SDK.
`test/unit-setup.ts` also blocks every test process from starting a real `claude`
binary and points the API at a closed local port, so a broken mutant cannot
reach Anthropic or write to your `~/.claude`.

## Regenerating the knobs catalog

```sh
npm run catalog
```

This pulls the settings, env var and CLI reference pages from code.claude.com and rewrites
`src/core/knobs/catalog.generated.json`.
