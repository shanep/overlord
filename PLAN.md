# Overlord Plan

Overlord is a VS Code extension that works like htop for Claude Code. It shows
every running session and subagent, what is in each one's context and why, and
every knob we can turn. It also launches and drives agents itself, so VS Code
becomes the harness for running many agents and prompts at once.

This plan is based on Claude Code 2.1.301 on this Mac, the official docs at
code.claude.com (read 2026-10-15), and what is actually on disk in `~/.claude`
and `~/Library/Application Support/Claude`.

## Goals

1. See everything that is running: sessions, subagents, background tasks, cloud
   sessions, with live state, tokens, cost and tool activity.
2. See everything that drives the model: system prompt, memory files, rules,
   skills, agents, MCP instructions, and why each one did or did not load.
3. Tune every documented knob (settings, env vars, CLI flags, per-session
   runtime controls) from one place, with the effective value and where it
   came from.
4. Run many agents and prompts at once from VS Code, side by side.
5. Define new agents and skills quickly.
6. Keep all config in a separate GitHub repo so a new machine is one install
   and one clone away from an identical setup.
7. One list of sessions across the CLI, Claude Desktop (Code tab and Cowork),
   Claude Code on the web, and claude.ai, with handoff between local and cloud.
8. All code tested, with the strictest tooling we can find, set to the max.

## Where the data comes from

The rule is to prefer documented surfaces and to treat undocumented files as
read-only, version-gated sources that can break on any update.

| Source                                                                  | What it gives us                                                                                                                                                                                                                                                                                     | Documented                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Agent SDK `@anthropic-ai/claude-agent-sdk`                              | Full control of sessions Overlord launches: streaming messages, `interrupt()`, `setModel()`, `setPermissionMode()`, `applyFlagSettings()`, `getContextUsage()`, `mcpServerStatus()`, `rewindFiles()`, `canUseTool` permission callback, task started/progress/notification events, rate limit events | Yes                                              |
| Hooks (33 events)                                                       | Live events from every session, including ones started in a terminal. `InstructionsLoaded` gives `file_path`, `memory_type`, `load_reason`, `trigger_file_path`, `parent_file_path`. `SubagentStart`/`SubagentStop` give the agent tree. `PermissionRequest` lets us approve from the UI             | Yes                                              |
| OpenTelemetry                                                           | `claude_code.cost.usage` and `token.usage` by model, agent, skill, plugin and MCP tool. `api_request`, `tool_result`, `tool_decision` events. Beta traces with `ttft_ms` per request                                                                                                                 | Yes                                              |
| Status line payload                                                     | Context window use, prompt cache hit ratio and miss causes, rate limits (5 hour, 7 day), cost                                                                                                                                                                                                        | Yes                                              |
| `claude agents --json`                                                  | Active interactive and background sessions: `id`, `kind`, `pid`, `cwd`, `state`, `status`                                                                                                                                                                                                            | Yes                                              |
| Settings files, `.claude/` dirs, skills, agents, output styles, plugins | Static config inventory                                                                                                                                                                                                                                                                              | Yes                                              |
| `~/.claude/projects/<project>/<session>.jsonl`                          | Full transcript: messages, usage per request, `instructions`, `nested_memory`, `prompt_snapshot` (the exact system prompt), skill listings, invoked skills, MCP instruction deltas, permission mode changes                                                                                          | No, docs say the format changes between versions |
| `.../<session>/subagents/agent-<id>.jsonl` and `.meta.json`             | Subagent transcripts, type, description, spawn depth, and the `toolUseId` that links back to the parent                                                                                                                                                                                              | No                                               |
| `~/.claude/sessions/<pid>.json`                                         | Live session registry with status and a messaging socket path                                                                                                                                                                                                                                        | No                                               |
| `~/.claude/stats-cache.json`                                            | Daily activity, tokens per model, hour of day counts                                                                                                                                                                                                                                                 | No                                               |
| `~/.claude.json`                                                        | MCP servers, per-project state, cached feature flags (`cachedGrowthBookFeatures`). Also OAuth account and IDs, which we never copy anywhere                                                                                                                                                          | No                                               |
| `~/Library/Application Support/Claude/claude-code-sessions/`            | Desktop Code tab sessions, each with a `cliSessionId` that maps to a transcript in `~/.claude/projects`                                                                                                                                                                                              | No                                               |
| `~/Library/Application Support/Claude/local-agent-mode-sessions/`       | Cowork sessions: title, cwd, model, system prompt, MCP tools, `audit.jsonl`, outputs                                                                                                                                                                                                                 | No                                               |
| claude.ai data export (`conversations.json`)                            | claude.ai chat history, imported by hand                                                                                                                                                                                                                                                             | Partly                                           |

Every undocumented parser gets a version range it was tested against. Outside
that range Overlord shows the data with a "format not verified" badge instead
of silently showing wrong numbers.

## Architecture

```text
VS Code extension host (Node)
  core/          pure TypeScript, no vscode imports, 100% unit tested
    sources/     transcript tailer, session registry, hook receiver,
                 OTLP receiver, config scanner, desktop/cowork reader,
                 claude.ai export importer, SDK runner
    model/       normalized entities: Session, Agent, Task, Request,
                 ToolCall, ContextItem, Setting, ConfigItem
    store/       event bus + bounded in-memory ring buffers (history is
                 reread from transcripts, so nothing is persisted)
    resolver/    context provenance ("why loaded / why not")
    knobs/       settings and env var catalog, layer merge, provenance
    sync/        config repo manifest, link/apply/diff, secrets
  host/          thin vscode adapter: commands, tree views, status bar,
                 SecretStorage, webview messaging
webviews/        React + ECharts, built with Vite, typed message protocol
bin/overlord-hook  tiny Node script that every hook calls, forwards JSON to
                 the extension over a local socket, exits 0 fast if
                 Overlord is not running
```

Key decisions:

- **Two kinds of sessions.** Sessions Overlord launches go through the Agent
  SDK, so we get full control. Sessions started anywhere else are observed
  through hooks, OTel and transcript tailing, and we can still approve
  permissions and stop them.
- **Hooks are opt-in.** Overlord asks before it adds its hook block to
  `~/.claude/settings.json`, marks the block clearly, and removes it on
  uninstall. One command hook for all events keeps the settings file small.
- **OTel goes to localhost only.** Overlord runs an OTLP/HTTP JSON receiver on
  127.0.0.1 and sets the `CLAUDE_CODE_ENABLE_TELEMETRY` and `OTEL_*` env vars
  in user settings when you turn it on. Content logging stays off unless you
  flip it.
- **Big history stays lazy.** There are 863 transcripts (511 MB) on this
  machine. We tail only active files, index the rest in a worker thread, and
  dedupe usage by message ID (one API call spans several transcript lines that
  repeat its usage).
- **Webviews never touch Node.** They get data through a typed message
  protocol, which dependency-cruiser enforces.

## Views

### Fleet (the htop view)

A tree of every session, its subagents (nested to spawn depth 3), and its
background tasks. Columns: state (running, waiting on you, idle, done,
failed), surface (CLI, Desktop, Cowork, cloud, Overlord), model, effort,
elapsed time, current tool, tool calls per minute, tokens in/out, cache hit
ratio, context used, cost. Sparklines per row. Sort and filter like htop.

Row actions: open detail, interrupt, stop, attach in terminal, approve a
pending permission, change model or permission mode (SDK sessions live, others
on next turn where possible), fork, move to cloud.

A status bar item shows running agents, spend rate per hour, and 5 hour rate
limit use.

### Agent detail

- Live feed of thinking, text and tool calls, with tool input and output.
- Gantt timeline of tool calls and API requests (parallel tool calls show as
  stacked bars), with time to first token per request from OTel traces.
- Charts: tokens and cost over time, context window fill with compaction
  marks, prompt cache hits and misses with the miss causes.
- Subagent drill-down: the same view for any child, linked to the parent tool
  call that spawned it. For example, the claude-code-guide agent from the
  session that wrote this plan made 41 tool calls (28 web fetches, 13 shell
  commands) over 4 minutes 55 seconds.

### Context inspector (what is driving the AI)

For any session, at any point in time:

1. **System prompt** from `prompt_snapshot`, with a diff between sessions or
   versions.
2. **Memory files that loaded**, each with path, tier (Managed, User, Project,
   Local, AutoMem), load reason (`session_start`, `nested_traversal`,
   `path_glob_match`, `include`, `compact`), the file that triggered a lazy
   load, the importing file for `@` imports, and whether the loaded text still
   matches the file on disk.
3. **Files that did not load, and why.** The resolver rebuilds Claude Code's
   discovery rules for the session's cwd and settings, lists every candidate,
   and compares against what loaded. Example reasons:
   - excluded by a `claudeMdExcludes` pattern (names the pattern and layer)
   - in a subdirectory nothing has touched yet (lazy, not loaded)
   - `paths` glob in a rule never matched a touched file
   - `@import` deeper than 4 hops, or inside a code span
   - external import waiting for approval
   - AGENTS.md skipped because a CLAUDE.md exists in cwd or an ancestor
   - `--add-dir` without `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`
   - `MEMORY.md` past 200 lines or 25 KB (shows the cut point)
   - auto memory off (`autoMemoryEnabled`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`)
   - all CLAUDE.md off (`CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `--bare`,
     `--safe-mode`, `--setting-sources`)
   - subagent with `omitClaudeMd: true`, or main auto memory not passed to
     subagents
4. **Skills** listed (name and description weight), invoked (with source:
   user, project, plugin, claude.ai synced), and hidden
   (`disable-model-invocation`).
5. **Agents, MCP server instructions, deferred tools, output style, git status
   and environment block.**
6. **Token weight** of each piece from `getContextUsage()` for SDK sessions,
   estimated for others, shown as a treemap.

### Knobs

One editor for everything we can set, grouped by area (model, thinking,
context and compaction, caching, subagents, bash, MCP, telemetry, memory,
permissions, UI).

- Catalog of every documented settings key, env var and CLI flag, with
  default, allowed values, and doc link. The env var list alone runs past 150
  entries (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `BASH_MAX_OUTPUT_LENGTH`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, and so on).
  We generate the catalog from the docs pages in a build script, so a new
  Claude Code release only needs a refresh.
- **Effective value and provenance** for each key: which layer won (managed,
  CLI, project local, project, user, env), and what every lower layer said.
- **Where a change applies**: live in an SDK session, next turn, or next
  launch.
- **Launch profiles**: named sets of model, effort, permission mode, env vars
  and flags, used by the launcher.
- **Feature flags**: the cached server flags from `~/.claude.json`, read-only
  and clearly labeled. The server rewrites that cache, so editing it would not
  stick and could break things.

### Launcher (many agents, many prompts)

- A prompt queue with drafts, templates and variables.
- Run a batch: N prompts in parallel, each optionally in its own git worktree
  so they do not stomp on each other.
- Matrix runs: one prompt across models, effort levels or profiles, compared
  side by side (result, diff, cost, time, turns).
- Live spend per session and for the whole fleet, optional caps
  (`maxBudgetUsd` per session plus a fleet total, off by default), max
  concurrency, and a kill switch.
- Permission inbox: every pending approval from every agent in one list, plus
  auto-approve rules (tool, path and command patterns) that you write and can
  turn off in one click. Every auto-approval is logged.
- Results view with diffs per worktree and a "merge this one" action.

### Sessions everywhere

One list across every surface, with handoff where Claude Code supports it.

| Surface                   | How we list it                                              | Handoff                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI and Overlord sessions | transcripts, `claude agents --json`                         | resume, fork                                                                                                                                                  |
| Desktop Code tab          | `claude-code-sessions/*.json` → `cliSessionId` → transcript | open in Desktop with `claude --desktop --resume <id>`                                                                                                         |
| Cowork                    | `local-agent-mode-sessions/*.json` and `audit.jsonl`        | hand a session to Desktop with `claude --desktop`, more once M0 finds what Cowork accepts                                                                     |
| Claude Code on the web    | SDK `remote_agent` tasks, `--cloud` sessions we created     | pull to local with `claude --teleport <id>`, start a cloud session with `claude --cloud`, steer a local session from the web or phone with `--remote-control` |
| claude.ai chats           | import of the official data export                          | view and search only                                                                                                                                          |

What is not possible yet, so we are clear going in:

- There is no documented API that lists claude.ai chats live. Overlord will
  import the data export, and we will not scrape the web app with a session
  cookie.
- I have not found a documented way to move an existing local conversation
  into a cloud session. `--cloud` starts a new cloud session from a
  description, and `--teleport` goes the other way. M0 checks this, and the
  fallback is to start the cloud session with a generated summary of the
  local one.
- Cowork runs in a local VM in Claude Desktop, not in the cloud. Overlord
  supports both handoffs: local to and from Claude Code on the web, and local
  to Desktop. M0 confirms what Cowork accepts.

### Config and sync

Every config item on the machine in one tree, each with a badge:

| Badge         | Meaning                                                | Example on this machine                                       |
| ------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| Versioned     | in the config repo, clean                              | `~/.claude/CLAUDE.md`, `settings.json`, `writing-voice` skill |
| Modified      | in the config repo with uncommitted changes            | settings Claude wrote with `/config`                          |
| External repo | symlink into another git repo                          | `canvas` skill from `~/repos/edutools`                        |
| Local only    | not versioned anywhere                                 | per-project auto memory                                       |
| Cloud synced  | pushed from claude.ai                                  | `~/.claude/skills/synced/`                                    |
| Plugin        | provided by an installed plugin                        | `pyright-lsp`, `clangd-lsp`                                   |
| Managed       | from managed policy                                    | none here                                                     |
| Built-in      | ships with Claude Code                                 | Explore, Plan, claude-code-guide                              |
| Secret        | value lives in the OS keychain, repo has a placeholder | MCP tokens                                                    |

Actions: adopt into the repo, push, pull, diff, revert, move between user and
project scope.

### Authoring

- "New agent" and "New skill" forms that write valid frontmatter (name,
  description, tools, model, effort, permissionMode, isolation, memory, paths,
  and the rest), validated against a schema of the documented fields.
- Option to describe it in plain words and have Claude draft it, then edit.
- A "try it" button that launches an SDK session with the new agent or skill.
- Saves to user scope (into the config repo), project scope, or a plugin.

### Usage

History from `stats-cache.json` and transcripts: daily tokens and cost per
model, activity by hour, top projects, top tools, cache savings, rate limit
use over time.

## Config repo and new machine setup

A separate repo, `shanep/overlord-config` by default, that Overlord owns:

```text
overlord-config/
  overlord.json         manifest: every item, its target path, how to link it
  global/CLAUDE.md
  global/settings.json  shared settings
  global/rules/
  skills/<name>/
  agents/*.md
  commands/
  output-styles/
  hooks/                hook scripts
  mcp.json              MCP servers with ${secret:NAME} placeholders
  plugins.json          marketplaces and enabled plugins, with versions
  external.json         skills that live in other repos (repo URL + path)
  machines/<host>.json  per-machine overrides
  memory/               auto memory for every project, keyed by git remote
                        URL, not path, so it matches across machines
```

How it applies:

- Content files (CLAUDE.md, skills, agents, rules) are symlinked, which is
  what dot-files already does, so edits by Claude show up as git changes.
- `settings.json` is generated from `global/settings.json` plus
  `machines/<host>.json`. Overlord watches it, and when Claude writes to it,
  offers to push that change into the shared file or the machine file.
- MCP servers go in through `claude mcp add-json` and plugins through
  `claude plugin`, not by editing `~/.claude.json`.
- Secrets live in VS Code SecretStorage (the OS keychain) and are filled in at
  apply time. A denylist keeps OAuth data, user IDs, machine IDs and caches out
  of the repo, and a pre-commit check scans for tokens.
- Claude Code version is pinned in the manifest so `claude install <version>`
  can match it.

New machine: install the extension, run "Overlord: Connect config repo", sign
in to GitHub, and it clones the repo and its external repos. It then shows a
dry run of every link and overwrite, backs up the current `~/.claude` to
`~/.claude/backups/overlord-<timestamp>`, and applies.

This machine: a one-time import from `shanep/dot-files` that moves
`claude/CLAUDE.md`, `claude/settings.json` and `claude/skills/writing-voice`
into the new repo and repoints the symlinks.

## Code quality and testing

Everything at its strictest setting, enforced in CI, zero warnings allowed.

TypeScript:

- `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noImplicitReturns`, `noPropertyAccessFromIndexSignature`,
  `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`,
  `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`,
  `allowUnreachableCode: false`, `allowUnusedLabels: false`.
- `@tsconfig/strictest` as the base so nothing is missed.
- `type-coverage --strict --at-least 100`. No `any`, and every `as` cast needs
  a comment saying why (same rule as `cast()` in Python).
- All external data (transcripts, hook JSON, OTel, settings files) is parsed
  with zod schemas at the boundary, so bad input is a typed error, not a crash.

Linting and checks:

- ESLint flat config with `typescript-eslint` `strictTypeChecked` and
  `stylisticTypeChecked`, plus `unicorn`, `sonarjs`, `import-x`, `promise`,
  `n`, `regexp`, `security`, `react`, `react-hooks`, `jsx-a11y`, and
  `@vitest/eslint-plugin`. `--max-warnings 0`.
- Prettier for formatting, checked in CI.
- knip for unused files, exports and dependencies.
- dependency-cruiser for layer rules: `core/` cannot import `vscode`,
  webviews cannot import Node, no cycles.
- cspell, markdownlint, and a small script that fails the build on any em dash
  or en dash in the repo.
- `npm audit`, osv-scanner, and CodeQL for dependencies and security.
- publint and a bundle size budget for the packaged extension.
- lefthook runs lint, types and unit tests before each commit.

Tests:

- **Unit (Vitest)**: 100% line, branch, function and statement coverage on
  `core/`, enforced as a threshold. `core/` has no vscode imports, which is
  what makes 100% realistic.
- **Property tests (fast-check)** for parsers, the layer merge, and the
  context resolver.
- **Mutation tests (Stryker)** on `core/`, break threshold 90%, so tests have
  to actually check behavior and not just run lines.
- **Contract tests** against a fixture corpus of real, scrubbed transcripts,
  hook payloads and OTel exports from each Claude Code version we support. A
  new version adds fixtures, and any format change fails loudly.
- **Fake Claude**: a stub binary passed to the SDK as
  `pathToClaudeCodeExecutable` that replays recorded stream-json, so launcher
  and fleet tests run without the API or cost.
- **Integration (`@vscode/test-electron`)**: activation, commands, tree views,
  hook install and removal, settings round trips.
- **Webview tests**: Vitest with jsdom and Testing Library for every view and
  component, plus axe accessibility checks on every view. Playwright visual
  snapshots of each chart in light and dark themes are still to do.
- **Sync tests**: apply, diff and revert against a temp HOME and a temp git
  remote, on macOS and Linux.
- **CI**: GitHub Actions matrix on macOS and Ubuntu, every check above
  required to pass.

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
