# Phase 3, order and decisions

## Phase 3: words and docs

Starts after G and at least one new agent reach milestone 2.

- **Help** (`webview/src/views/help-*.ts(x)`): the Claude lifecycle text
  (`claude --bg`, `attach`, `agents`, `stop`) becomes the Claude section of
  per-agent help, driven by capabilities.
- **README.md and PLAN.md**: describe Overlord as a meta harness with Claude
  Code as one adapter. PLAN.md's data source table gets a column per agent.
- **package.json**: description and keywords, command titles ("New Claude
  Code Session" stays as a command, next to "New Session..."), setting
  descriptions that say "your Claude settings".
- **cspell.json**: the new agent words.

## Order and parallelism at a glance

```text
Phase 0   P0.1 contracts --+   P0.2 store   P0.3 tests
                           |
Phase 1                    +-- A  B  C  D  E1  E2  E3  E4  E5  F  G  H   (12 in parallel)
                           |
Phase 2                    +-- N0 fixtures --+-- N2 Copilot  (parsers now, plug in as seams land)
                           |                 +-- N3 Codex
                           +-- N1 ACP -------+-- N4 custom ACP
                           |
Phase 3                    +-- help, README, PLAN.md, package.json (after G and one agent at M2)
```

The longest chain is P0.1, then A and C, then N2 milestone 3. Everything
else can run beside it. A sensible first wave is P0.1, P0.2, P0.3 and N0.
The second wave is all of Phase 1 plus N1 and the parser halves of N2 and
N3.

## Decisions

Decided with Shane on 2026-10-16. Nothing is open.

1. **Gemini is out.** No Gemini CLI or Antigravity CLI adapter. Anyone who
   wants it later can add it as a custom ACP agent (N4).
2. **Copilot first, then Codex.** Copilot is installed and ships its own
   event schema.
3. **`config.toml` gets targeted edits only**, never a full rewrite (see
   "Editing Codex's config.toml").
