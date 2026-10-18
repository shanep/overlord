# Goals and data sources

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

The table above is Claude Code's. The other agents have the same kinds of
sources, and each adapter reads its own:

| Source       | Claude Code                               | Codex CLI                                                    | Copilot CLI                                                  |
| ------------ | ----------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Transcripts  | `~/.claude/projects/<project>/<id>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, undocumented | `~/.copilot/session-state/<id>/events.jsonl`, schema shipped |
| Live driver  | Agent SDK                                 | `codex app-server` (JSON-RPC)                                | `copilot --acp`, through the generic ACP runtime             |
| Terminal     | `claude --bg`, `attach`, `agents`, `stop` | `codex`, `codex resume <id>`, `codex fork <id>`              | `copilot --session-id <id>`, `--resume=<id>`                 |
| Hooks        | `~/.claude/settings.json`, 33 events      | `~/.codex/hooks.json`                                        | `~/.copilot/hooks/*.json`, `.github/hooks/*.json`            |
| OTel         | env vars, `claude_code.*` metrics         | `[otel]` in `config.toml`                                    | `COPILOT_OTEL_ENABLED`, HTTP only                            |
| Settings     | `settings.json` layers (JSON)             | `~/.codex/config.toml` (TOML, targeted edits only)           | `~/.copilot/settings.json` (JSONC)                           |
| MCP          | `~/.claude.json`, `.mcp.json`             | `[mcp_servers.<id>]` in `config.toml`                        | `~/.copilot/mcp-config.json`                                 |
| Instructions | `CLAUDE.md`, rules, auto memory           | `AGENTS.md`, root down to the folder                         | `AGENTS.md`, `.github/copilot-instructions.md`, `CLAUDE.md`  |

Today Overlord reads the transcripts and MCP servers of all three, starts
Codex and Copilot in terminal tabs, and runs Copilot from the Launcher over
ACP. The rest is in use for Claude Code and lands for the others milestone by
milestone, as META-HARNESS.md tracks.

Every undocumented parser gets a version range it was tested against. Outside
that range Overlord shows the data with a "format not verified" badge instead
of silently showing wrong numbers.
