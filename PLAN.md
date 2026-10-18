# Overlord Plan

Overlord is a VS Code extension for running a fleet of coding agents. It shows
every running session and subagent, what is in each one's context and why, and
every knob we can turn. It also launches and drives agents itself, so VS Code
becomes the harness for running many agents and prompts at once.

Overlord is a meta harness. Each agent CLI (Claude Code, Codex CLI, Copilot
CLI) plugs in as an adapter under `src/core/agents/`, and the views show only
what that agent can do. Claude Code was the first adapter and is still the
fullest. [META-HARNESS.md](META-HARNESS.md) has the adapter design and what
has landed.

The Claude parts of this plan are based on Claude Code 2.1.301 on this Mac,
the official docs at code.claude.com (read 2026-10-15), and what is actually
on disk in `~/.claude` and `~/Library/Application Support/Claude`.

## Sections

- [Goals and data sources](docs/plan/goals-and-data.md): what Overlord is for, and where each piece of data comes from on disk and over the wire
- [Architecture](docs/plan/architecture.md): the module layout of the extension host, core and webviews
- [Views](docs/plan/views.md): what each view shows: Fleet, Agent detail, Context inspector, Knobs, Launcher, Sessions, Config and sync, Authoring, Usage
- [Config repo and new machine setup](docs/plan/config-repo.md): the config repo layout and setting up a new machine from it
- [Code quality and testing](docs/plan/code-quality.md): the type, lint, test and CI rules
- [Milestones, risks and decisions](docs/plan/milestones-risks-decisions.md): the milestones, the known risks, and the decisions made
