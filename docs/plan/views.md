# Views

## Fleet (the htop view)

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

## Agent detail

- Live feed of thinking, text and tool calls, with tool input and output.
- Gantt timeline of tool calls and API requests (parallel tool calls show as
  stacked bars), with time to first token per request from OTel traces.
- Charts: tokens and cost over time, context window fill with compaction
  marks, prompt cache hits and misses with the miss causes.
- Subagent drill-down: the same view for any child, linked to the parent tool
  call that spawned it. For example, the claude-code-guide agent from the
  session that wrote this plan made 41 tool calls (28 web fetches, 13 shell
  commands) over 4 minutes 55 seconds.

## Context inspector (what is driving the AI)

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

## Knobs

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

## Launcher (many agents, many prompts)

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

## Sessions everywhere

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

## Config and sync

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

## Authoring

- "New agent" and "New skill" forms that write valid frontmatter (name,
  description, tools, model, effort, permissionMode, isolation, memory, paths,
  and the rest), validated against a schema of the documented fields.
- Option to describe it in plain words and have Claude draft it, then edit.
- A "try it" button that launches an SDK session with the new agent or skill.
- Saves to user scope (into the config repo), project scope, or a plugin.

## Usage

History from `stats-cache.json` and transcripts: daily tokens and cost per
model, activity by hour, top projects, top tools, cache savings, rate limit
use over time.
