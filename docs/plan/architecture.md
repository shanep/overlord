# Architecture

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
