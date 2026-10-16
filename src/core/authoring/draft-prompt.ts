// The prompt Overlord sends when the user describes an agent or skill in plain
// words and wants Claude to draft the file.
// cspell:words xhigh

import type { AuthoringKind } from './schema.js';

const AGENT_GUIDE = `Write a Claude Code subagent definition file (.claude/agents/<name>.md).

Frontmatter fields:
- name (required): lowercase letters, digits and hyphens, such as code-reviewer. No ":" and no leading "-".
- description (required): when Claude should delegate to this subagent. Start with what it does, then "Use when ...".
- tools: comma-separated list such as "Read, Grep, Glob". Leave it out to inherit every tool. Grant only what the task needs.
- disallowedTools: tools to remove, same format as tools.
- model: sonnet, opus, haiku, fable, inherit, or a full model ID.
- permissionMode: default, acceptEdits, auto, dontAsk, bypassPermissions or plan.
- maxTurns: a whole number.
- skills: list of skill names to preload.
- memory: user, project or local.
- background: true to always run in the background.
- effort: low, medium, high, xhigh or max.
- isolation: worktree, to run in a temporary git worktree.
- omitClaudeMd: true to start without CLAUDE.md files.
- color: red, blue, green, yellow, purple, orange, pink or cyan.

The body after the frontmatter is the subagent's system prompt. Write it in the second person, say what to do step by step, and say what to report back.`;

const SKILL_GUIDE = `Write a Claude Code skill file (.claude/skills/<name>/SKILL.md).

Frontmatter fields:
- name: lowercase letters, digits and hyphens, such as fix-issue. No ":" and no leading "-".
- description: what the skill does and when to use it. Keep description plus when_to_use under 1,536 characters.
- when_to_use: extra context for when Claude should invoke it.
- argument-hint: autocomplete hint such as "[issue-number]". Quote it.
- arguments: list of named positional arguments, used in the body as $name.
- disable-model-invocation: true when only the user should run it (deploys, anything with side effects).
- user-invocable: false when only Claude should use it (background knowledge).
- allowed-tools: list of tools Claude can use without asking while the skill runs.
- model, effort (low, medium, high, xhigh, max).
- context: fork, to run in a subagent. agent: the subagent type to use with fork.
- paths: list of glob patterns that limit automatic activation to matching files.

The body is the instructions Claude follows when the skill runs. $ARGUMENTS expands to everything typed after the skill name.`;

/** The full prompt. The reply is expected to be the file text and nothing else. */
export function buildDraftPrompt(kind: AuthoringKind, description: string): string {
  const guide = kind === 'agent' ? AGENT_GUIDE : SKILL_GUIDE;
  return `${guide}

Only include fields the request needs. Use plain hyphens, never em dashes or en dashes.

Reply with only the file content: start with the "---" line that opens the YAML frontmatter, and do not wrap it in a code fence or add any commentary before or after it.

What the user wants:
${description.trim()}
`;
}

const FENCED = /^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/u;

/** Takes the file text out of a reply, unwrapping a code fence if Claude added one anyway. */
export function extractDraftText(reply: string): string {
  const trimmed = reply.trim();
  const fenced = FENCED.exec(trimmed);
  const inner = fenced?.[1] ?? trimmed;
  return `${inner.trim()}\n`;
}
