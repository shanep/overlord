# Overlord

![Overlord: run a fleet of coding agents from VS Code](media/banner.png)

SkyNet version 1.0, let it begin.

Overlord is a VS Code extension for running a fleet of coding agents. It is a meta harness: each
agent CLI plugs in as an adapter, and Claude Code is one of them. It launches a batch of prompts
side by side, each in its own git worktree, and shows every running session and subagent, what
is in each one's context and why, and every knob you can turn.

See [PLAN.md](PLAN.md) for the full design and the decisions behind it, and
[META-HARNESS.md](META-HARNESS.md) for how the agent adapters are built.

## Agents

Overlord supports three agent CLIs today. Each one gets the parts of Overlord it supports, and
the views leave out the rest, so a dash in the Fleet means that agent does not report the
number. Claude Code has the most, since Overlord started as a tool for it.

| Feature                          | Claude Code | Codex CLI | Copilot CLI |
| -------------------------------- | ----------- | --------- | ----------- |
| Sessions in the Fleet            | Yes         | Yes       | Yes         |
| New session in a terminal tab    | Yes         | Yes       | Yes         |
| Continue a session               | Yes         | Yes       | Yes         |
| Fork a session                   | Yes         | Yes       | No          |
| Background jobs                  | Yes         | No        | No          |
| Launcher runs                    | Yes         | No        | Yes         |
| Permission inbox and interrupt   | Yes         | No        | Yes         |
| Subagents                        | Yes         | No        | Yes         |
| Cache share                      | Yes         | Yes       | Yes         |
| Cost                             | Yes         | No        | Yes         |
| Context Inspector                | Yes         | No        | No          |
| MCP servers in Connectors        | Yes         | Yes       | Yes         |
| Hooks, coordination and messages | Yes         | No        | No          |
| Desktop, cloud and claude.ai     | Yes         | No        | No          |

Codex reports no cost because a ChatGPT plan bills by limits, not tokens. Copilot reports what
each session cost itself. **Help** in the sidebar has the same table, built from what each
installed adapter says it can do, so it is the one to trust when this one falls behind.

### Turn an agent on

1. Install the agent's CLI (`claude`, `codex` or `copilot`) so it is on your login shell's
   `PATH`.
2. Run it once in a terminal and sign in.
3. Reload the VS Code window so Overlord finds it. Its sessions show up in the Fleet, and
   **New session** above the Fleet offers it once more than one agent is installed.

Sessions you start in a terminal show up in the Fleet whatever the settings say, since Overlord
reads them from disk. The `overlord.agents` setting points Overlord at another binary or stops
it from starting sessions of an agent:

```json
"overlord.agents": {
  "codex": { "path": "/opt/homebrew/bin/codex" },
  "copilot": { "enabled": false }
}
```

`overlord.claudePath` still works and wins over `overlord.agents["claude-code"].path`.

### Add any other ACP agent

Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) over
stdio can run from the launcher. Add it to `overlord.customAgents` in your VS Code settings:

```json
"overlord.customAgents": [
  {
    "id": "gemini",
    "name": "Gemini CLI",
    "command": "gemini",
    "args": ["--experimental-acp"],
    "env": { "GEMINI_API_KEY": "..." }
  }
]
```

Once `command` is on your login shell's `PATH` (or is an absolute path), the agent shows up under
**Which agent?** in the launcher. Its runs ask for approval in the permission inbox, and Interrupt
and Stop work. That is all you get, since Overlord does not read its transcripts, install hooks in
it or edit its config. Add `modes` (a list of `{ "id", "label" }`) if you want profiles to pick
one of its permission modes. An entry with a broken field, or with the id of a built-in agent, is
skipped with a warning.

## What it does

- **Claude Code in a tab**: **Overlord: New Claude Code Session** (or the sparkle button in the
  Overlord sidebar) asks which project to start in, with this window's folder first, so Enter
  starts where it always did. It starts a `claude` session in the background, in its own worktree
  of that project's repo (see [Worktrees](#worktrees)), and attaches an editor tab to it. Closing the tab
  leaves the session running in the background instead of asking to terminate it, and clicking it in
  the Fleet attaches a new tab. Continue here works the same way. If Claude Code cannot start a
  background session, the tab runs `claude` itself, and with the official Claude Code extension
  installed it connects to VS Code on its own, so diffs open in the editor and Claude sees your
  selection.
- **Other agents in a tab**: **New session** above the Fleet starts the agent you pick in a
  terminal tab, in its own worktree, the same as the sparkle. Codex runs `codex` and Continue
  runs `codex resume <id>`. Copilot runs `copilot --session-id <id>` and Continue runs
  `copilot --resume=<id>`. These tabs run the CLI itself, so closing one ends its session.
- **Fleet**: every session, subagent and background task from every agent, with live state,
  tokens, cost, cache hit ratio and the tool it is running right now. Once the Fleet holds more
  than one agent, each row names its agent and the View menu filters by agent. An icon shows where each session runs (a VS
  Code terminal, another terminal or the background). Click a session to jump to its terminal
  tab, or to attach a tab to a background session. Switch terminal tabs and the fleet highlights
  the session in the one you are on. Switch to another VS Code window and its fleet highlights
  the session that ran in that window's folder. Sessions are grouped by project. A git repo is a
  project on its own, and its worktrees count as the repo. A session in any other folder lands
  in Unassigned, and the window running it asks once whether to add it to a project, make a new
  one, or never ask about that folder again. A project whose folder is in the window's workspace
  stays listed with no running sessions, and Hide done never hides it. The folder button on a project's row adds its folder
  to the current window and shows it in the Explorer, so you can edit it like any other folder, and
  the sparkle next to it starts a new session in that project. A project you made has no folder
  until you set one. Hide done, Group by project and Show working on live in the View menu above
  the list. Claude Code cannot join two conversations, so the combine button on a session's row
  starts a new session instead. Its first message is a digest of the sessions you pick: what you
  asked, the files they edited, the commits they made and their last reply. Then Overlord offers
  to stop the ones still running.
- **Open a project**: **Open project** above the Fleet (or **Overlord: Open Project...**) lists
  every project Overlord knows, including repositories whose sessions have aged out of the Fleet.
  Pick one, or choose any folder, then start a Claude Code session there, open it in a new
  window, or add it to this one.
- **Agent detail**: the live feed of thinking and tool calls, a tool timeline, and token, cost
  and context charts.
- **Session health**: Session Properties flags a session that is wearing out (a large context,
  compactions, a run of failed tool calls, cache misses, hours of activity) and says what to do
  about each one.
- **Context inspector**: for Claude Code sessions, the system prompt, every memory file that loaded (and why), and every
  file that did not load (and why not).
- **Knobs**: 700+ Claude Code settings, env vars and CLI flags pulled from its docs, grouped into areas
  like Permissions, Built-in tools and Sessions, with the effective value and which layer set
  it. You can set or remove a key at the user, project or local layer, add your own env vars,
  put CLI flags on a launch profile, and open each key's docs page. Filters narrow it to one
  kind or to only what is set.
- **Launcher**: run many prompts at once, across profiles, each in its own git worktree, with one
  permission inbox and auto-approve rules. Claude Code runs through the Agent SDK and Copilot
  over ACP (`copilot --acp`), and each profile picks its agent. Always allow on a pending request writes the rule for
  you: the exact command for Bash, or the whole tool otherwise. Launched sessions get a rocket
  in the Fleet and never age out, even across a reload. They stay until you remove them with
  the cross on their row.
- **All sessions**: sessions from every agent CLI, plus Claude Desktop, Cowork, cloud sessions and
  claude.ai chats, in one list with handoff between local and cloud.
- **Config and sync**: every config item with a badge for versioned, local only, external repo
  and so on, synced through a separate git repo so a new machine matches this one.
- **Skills** and **Agents**: every skill or agent installed in user, project and plugin scope,
  with **New skill** or **New agent** to make one from a template or have Claude draft it. Below
  that you can browse premade ones and install them. Skills come from Anthropic's own collection
  (anthropics/skills), Everything Claude Code (affaan-m/ECC), Superpowers (obra/superpowers) and
  the skills in wshobson/agents, or you
  can search skills.sh, which tracks every public skill and how often people install it. Agents
  come from VoltAgent/awesome-claude-code-subagents, Everything Claude Code and wshobson/agents. **Install** asks where it
  goes the same way New does, copies the skill's whole folder (scripts and references included)
  or the agent's file from GitHub, links it into `~/.claude` when the config repo holds it, and
  opens it so you can read it first. A skill can carry scripts Claude runs, so read before you
  install. Listing a collection takes one GitHub API call, signed with the editor's GitHub
  sign-in when there is one, since anonymous calls are limited to 60 an hour.
- **Usage**: daily tokens by model and activity by hour.
- **Activity**: what each running session costs this machine, like Activity Monitor or Task
  Manager. Each session row adds up CPU, memory, disk and network for every process it started
  (builds, test runners, dev servers), and opens to show them one by one. It flags processes
  that hog CPU, memory, disk or network, ones that are ready to run but starved of CPU, ones
  stuck in an uninterruptible wait (nearly always a slow disk or a hung network mount), and
  stopped or zombie processes. It also warns about machine wide trouble: high load, memory
  pressure, full swap, a nearly full disk, a filesystem that stops answering, and macOS slowing
  the CPU for heat. It samples every 2 seconds, only while the view is open. Disk use per
  process on macOS needs python3 from the Xcode command line tools.
- **Tuning**: tips from measuring every session transcript, such as how much of the spend goes
  to re-reading old context, sessions that never compact, huge tool output and denied tools.
  Each tip lists its pros and cons and when to skip it, since following one can mean giving up
  context a long session took hours to build. It also suggests skills and agents for work your
  sessions keep doing by hand, and **Create** writes one into `~/.claude` or the project.
  **Track from now** on a tip compares the sessions you start after that with the 30 days
  before, week by week, so you can see whether the advice made things better or worse. It
  checks the habit the tip is about, the cost per prompt, and the side effects its cons warn
  about. Setting a knob or creating a skill the tip names starts tracking on its own.
- **Connectors (MCP)**: every MCP server each agent has, read from its own config files
  (`~/.claude.json` and `.mcp.json` for Claude Code, `config.toml` for Codex,
  `~/.copilot/mcp-config.json` for Copilot), and every claude.ai connector (Google Docs, Drive,
  Gmail and the rest), plus Claude in Chrome and a Chrome that can run headless, with whether each one works right now. Claude in Chrome is checked by asking its own server
  which browsers are attached, so a closed Chrome shows up before a session needs it. **Sign in**
  runs `claude mcp login` in a terminal and **Open Chrome** starts Chrome and checks again.
  Overlord rechecks every ten minutes, and its SessionStart hook hands each new session the last
  result with an instruction to confirm the connectors its task needs before starting, so a
  missing one stops the work up front instead of halfway through a plan. Turn that off with
  `overlord.connectors.briefSessions`. **Add from the MCP registry** opens on the first page
  of the public registry at registry.modelcontextprotocol.io, pages through the rest on request
  or searches it by name, with
  filters for remote servers and npm, PyPI or Docker packages and a link to each server's
  repository. It installs a server for every project through the agent's own CLI
  (`claude mcp add-json --scope user`, `codex mcp add` or `copilot mcp add`), and asks which
  agent when more than one can take it. It asks for the API keys, headers and paths the
  registry says the server needs, and runs npm packages with `npx`, PyPI packages with `uvx` and
  images with `docker run`.
- **Keep awake**: while Overlord is open the computer does not sleep, so agents keep working and
  the machine stays reachable remotely. The display still turns off. Turn it off with
  `overlord.keepAwake`.

## Install

Download the latest `.vsix` from the GitHub releases page and install it:

```sh
gh release download --repo shanep/overlord --pattern overlord.vsix
code --install-extension overlord.vsix
```

Every release also has `overlord-X.Y.Z.vsix` if you want a specific version.

Then open the Overlord icon in the activity bar. For Claude Code, run **Overlord: Set Up Hooks
and Telemetry** to get live permission requests, memory load events and per-request cost. Both
are off until you turn them on, since they write to `~/.claude/settings.json`. Other agents need
no setup past [turning them on](#turn-an-agent-on).

**Help** under Global in the sidebar explains every icon and badge and walks through a
typical workflow.

## Worktrees

Every session Overlord starts, from **New Claude Code Session**, **New session** or the launcher,
gets its own git worktree, so many sessions can work in one repo without stepping on each other. Worktrees
live in `~/.overlord/worktrees`, outside the repo, in a folder named after the repo and the start
of the session id (such as `overlord-9ddebe83`), on a branch `overlord/<id>` cut from a fresh fetch
of the default branch.

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

### Sessions that share a repo

Worktrees keep sessions out of each other's files, but two sessions changing the same file still
conflict when the second one lands. With Overlord's hooks installed, Overlord tells each session
about the others so it can steer clear:

- When a session starts, it gets a list of the other sessions in the repo, what each one is
  working on and which files each one has changed. It gets the list again on a prompt when
  someone joins or leaves.
- The first time a session edits a file another session is also changing, Overlord pauses the
  edit and says who else has it. If the session makes the same edit again, it goes through.
- When new commits land on the default branch and change files a worktree also changed, the
  session in it is told to rebase now, while the conflict is still small. The Worktrees table
  shows these files too.

Turn this off with `overlord.coordination.enabled`.

### Compatibility check

Every new Claude Code session gets a compatibility check of its project, wherever it started: in
an Overlord worktree, in a checkout Overlord never touched, or in a folder outside git. Projects
started or worked on outside Overlord are the ones it is for. When a project is not fully set up,
the session starts its first reply by saying so and listing the Overlord features that will not
work there and how to fix each one:

- **Git**: a folder outside git gets no worktrees, coordination or landing.
- **Own worktree**: a session started outside Overlord works in the checkout itself, with no
  `OVERLORD_SLOT`, no `OVERLORD_PORT_BASE` and nothing for the Worktrees table to land.
- **Session coordination**: in a repo Overlord has never made a worktree for, sessions are not told
  about each other and clashing edits are not paused.
- **Landing**: with no default branch on origin, worktrees branch from the local HEAD and Land
  cannot push.
- **Worktree files**: ignored files such as `.env` stay behind when the repo has no
  `.worktreeinclude`.
- **Worktree setup**: dependencies other than `node_modules` (dotnet, cargo, Python and so on) are
  not restored when the repo has no `.overlord/setup.sh`.
- **Checks on commit and push**: no git hooks, or a hook manager that is not installed.
- **Separate ports per session**: fixed ports in launch settings, Vite, compose or `.env` files
  when nothing reads `OVERLORD_PORT_BASE`.

It also warns about instructions that disagree on how work lands (both lines quoted), required
checks an admin's direct push skips, build tools with no shim in `~/.claude/shims`, and memory or
instructions that tell a session to make its own worktree. Notes the session keeps to itself cover
the auto memory it shares with the main checkout and worktrees made outside Overlord.

The check runs in the background, in about half a second, so a session never waits on it. A
worktree Overlord hands out starts its repo's check before the session is up, so that session
hears the result at once. Elsewhere, the first session in a folder hears it with its first prompt
or tool call, and later ones at once while the result is under 10 minutes old. Resumed sessions
and sessions in your home folder are skipped. Turn this off with `overlord.worktrees.launchCheck`.

## Reputation leaderboard

The Reputation view has a global leaderboard: who the machines hunt first and who they keep as
pets. You see the board without uploading anything. Reading it sends only your entry's random id,
once you have one.

Uploading is a button. It asks how you want to show up (your GitHub login, a name you pick, or
Anonymous), then shows the exact JSON it will send and waits for you to confirm. That JSON is a
name, three counts, your average tokens a day over the last 60 days (from Claude Code's
`~/.claude/stats-cache.json`) and the ids of the achievements you have unlocked:

```json
{
  "name": "shanep",
  "kind": 6,
  "mean": 21,
  "prompts": 1998,
  "achievements": ["manners", "regular"],
  "tokensPerDay": 187537200
}
```

The board shows each person's achievements as a row of trophies next to their name, and their
tokens a day under it. Average 100 million tokens a day and you unlock **Token maxxer**.

Never prompt text, matched words, session titles or folder names. The server works out the
score and rank from the counts. To know who is uploading, it checks your GitHub sign-in once
with GitHub (the `read:user` scope), keeps your GitHub id and login, and drops the token. Each
account gets one row, replaced on every upload, up to 5 uploads a UTC day. Anyone with fewer than
100 prompts is left off the board. **Remove my entry** deletes your row from the view and the web
page.

The server is a Cloudflare Worker with a D1 database, in `src/leaderboard/` and `leaderboard/`.
Deploy it with `node scripts/deploy-leaderboard.mjs` after `npx wrangler login`. Turn off
`overlord.leaderboard.enabled` and Overlord never calls the server at all.

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

## Releasing

Pushing a `v*` tag is the release. The script tags the tip of `origin/master`,
but only once CI has passed on it (it waits if CI is still running):

```sh
scripts/create-release.sh patch        # or minor, major, or an exact 1.2.0
scripts/create-release.sh -n minor     # dry run, tags nothing
```

CI then reruns every check on the tag, packages the `.vsix` with the tag's
version and publishes the GitHub release, with notes listing the commits since
the last one. The version in `package.json` is a placeholder for local builds,
so a release never needs a version bump commit.

Publishing to the VS Code Marketplace turns on once the repo has a `VSCE_PAT`
secret, a Marketplace token for the `shanep` publisher:

```sh
gh secret set VSCE_PAT --repo shanep/overlord
```

## Testing

```sh
npm test                       # unit tests
npm run test:related -- <files> # only the tests that import those files
npm run test:coverage          # unit tests with the 90% coverage gate
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
- pre-push (well under a minute for a small change): `npm run check:fast`, which lints the
  files and runs the tests affected since `origin/master`. A change to the ESLint, TypeScript
  or package setup lints everything.

The hooks only lint what changed, so a type change in one file can hide an error in another
until CI's full lint catches it.

Typecheck, lint, test, mutation and type coverage scripts run through `scripts/slot.mjs`, which
lets only a third of the cores' worth of them run at once across the machine. With many sessions
checking their work together, taking turns finishes each one sooner than running them all at
once. Set `OVERLORD_CHECK_SLOTS` to change the limit.

None of the tests call a model API. Sessions run against a fake Claude binary in
`test/fake-claude/` that replays scripted conversations through the real Agent SDK, and the
other agents have fakes under `test/fake-agents/`. `test/unit-setup.ts` also blocks every test
process from starting a real `claude`, `codex` or `copilot`, points each agent's home at a
temporary folder and points the API at a closed local port, so a broken mutant cannot reach a
provider or write to your `~/.claude`.

## Regenerating the knobs catalog

```sh
npm run catalog
```

This pulls the settings, env var and CLI reference pages from code.claude.com and rewrites
`src/core/knobs/catalogs/claude-code.json`. `npm run catalog -- claude-code` regenerates one
agent's catalog.
