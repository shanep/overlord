# Config repo and new machine setup

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
