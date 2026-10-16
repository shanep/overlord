# Overlord

SkyNet version 1.0, let it begin.

Overlord is a VS Code extension that works like htop for Claude Code. It shows every running
session and subagent, what is in each one's context and why, and every knob you can turn. It
also runs agents itself, so you can launch a batch of prompts and watch them side by side.

See [PLAN.md](PLAN.md) for the full design and the decisions behind it.

## What it does

- **Fleet**: every session, subagent and background task with live state, tokens, cost, cache
  hit ratio and the tool it is running right now.
- **Agent detail**: the live feed of thinking and tool calls, a tool timeline, and token, cost
  and context charts.
- **Context inspector**: the system prompt, every memory file that loaded (and why), and every
  file that did not load (and why not).
- **Knobs**: 700+ settings, env vars and CLI flags pulled from the docs, with the effective value
  and which layer set it.
- **Launcher**: run many prompts at once, across profiles, each in its own git worktree, with one
  permission inbox and auto-approve rules.
- **All sessions**: CLI, Claude Desktop, Cowork, cloud sessions and claude.ai chats in one list,
  with handoff between local and cloud.
- **Config and sync**: every config item with a badge for versioned, local only, external repo
  and so on, synced through a separate git repo so a new machine matches this one.
- **Usage**: daily tokens by model and activity by hour.

## Install

Grab the `.vsix` from the GitHub releases page and install it:

```sh
code --install-extension overlord-0.1.0.vsix
```

Then open the Overlord icon in the activity bar. Run **Overlord: Set Up Hooks and Telemetry**
to get live permission requests, memory load events and per-request cost. Both are off until
you turn them on, since they write to `~/.claude/settings.json`.

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

## Testing

```sh
npm test                  # unit tests
npm run test:coverage     # unit tests with the 100% coverage gate
npm run test:mutation     # Stryker, fails under a 90% mutation score
npm run test:integration  # runs the extension inside VS Code
npm run check             # every gate CI runs
```

`npm run check` runs typecheck, ESLint (zero warnings), Prettier, coverage, type coverage at
100%, knip, dependency-cruiser, cspell, markdownlint and the no-dashes check. The pre-push hook
runs it too.

None of the tests call the Claude API. Sessions run against a fake Claude binary in
`test/fake-claude/` that replays scripted conversations through the real Agent SDK.

## Regenerating the knobs catalog

```sh
npm run catalog
```

This pulls the settings, env var and CLI reference pages from code.claude.com and rewrites
`src/core/knobs/catalog.generated.json`.
