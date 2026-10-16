// Starting points for the "New agent" and "New skill" forms. Each one is a
// spec rather than raw text, so it always renders to a valid file.

import { renderAgent, renderSkill } from './render.js';
import type { AgentSpec, SkillSpec } from './schema.js';

interface TemplateBase {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
}

export type AuthoringTemplate =
  | (TemplateBase & { readonly kind: 'agent'; readonly spec: AgentSpec })
  | (TemplateBase & { readonly kind: 'skill'; readonly spec: SkillSpec });

const REVIEWER: AgentSpec = {
  frontmatter: {
    name: 'code-reviewer',
    description:
      'Reviews code changes for bugs, security problems and unclear code. Use after writing or changing code, before committing.',
    tools: 'Read, Grep, Glob, Bash',
    model: 'inherit',
    color: 'blue',
  },
  body: `You are a careful code reviewer.

When invoked:

1. Run \`git diff\` to see what changed. If nothing is staged or modified, review the files you were pointed at.
2. Read enough of the surrounding code to understand each change.
3. Look for bugs first, then security problems, then unclear or duplicated code.

Report findings grouped by severity (must fix, should fix, consider). For each one give the file and line, what is wrong, and a concrete fix. Do not edit files. If you find nothing worth fixing, say so plainly.
`,
};

const RESEARCHER: AgentSpec = {
  frontmatter: {
    name: 'researcher',
    description:
      'Answers questions about the codebase by searching and reading files. Use when a question needs many files read and only the answer matters.',
    tools: 'Read, Grep, Glob',
    model: 'haiku',
    color: 'cyan',
  },
  body: `You find answers in the codebase without changing it.

Search broadly first (file names, symbols, strings), then read the files that matter. Stop once you can answer with confidence.

Reply with the answer first, then the evidence: file paths with line numbers and short quotes. Say what you could not confirm.
`,
};

const TEST_WRITER: AgentSpec = {
  frontmatter: {
    name: 'test-writer',
    description:
      'Writes and runs unit tests for new or changed code. Use when code lacks tests or coverage drops.',
    tools: 'Read, Grep, Glob, Edit, Write, Bash',
    model: 'inherit',
    permissionMode: 'acceptEdits',
    color: 'green',
  },
  body: `You write focused unit tests that check behavior, not implementation details.

1. Find the project's test framework and follow the style of the existing tests.
2. Cover the normal path, edge cases and error handling of the code you were given.
3. Run the tests and fix any test you wrote that fails for the wrong reason.

Never change the code under test to make a test pass. If you find a real bug, stop and report it with a failing test.
`,
};

const BASIC_SKILL: SkillSpec = {
  frontmatter: {
    name: 'summarize-changes',
    description:
      'Summarizes uncommitted changes and flags anything risky. Use when the user asks what changed or wants a commit message.',
  },
  body: `## Current changes

!\`git diff HEAD\`

## Instructions

Summarize the changes above in two or three bullet points, then list any risks.
`,
};

const ARGUMENTS_SKILL: SkillSpec = {
  frontmatter: {
    name: 'fix-issue',
    description: 'Fixes a GitHub issue by number, with tests.',
    'argument-hint': '[issue-number] [branch]',
    arguments: ['issue', 'branch'],
    'disable-model-invocation': true,
    'allowed-tools': ['Bash(gh issue view *)', 'Read', 'Grep', 'Edit'],
  },
  body: `Fix GitHub issue $issue on branch $branch.

1. Read the issue with \`gh issue view $issue\`.
2. Find the code involved and write a failing test that shows the problem.
3. Make the smallest change that fixes it, then run the tests.
4. Summarize what you changed and why.
`,
};

export const TEMPLATES: readonly AuthoringTemplate[] = [
  {
    id: 'agent-reviewer',
    kind: 'agent',
    label: 'Code reviewer',
    summary: 'Read-only reviewer that reports bugs by severity.',
    spec: REVIEWER,
  },
  {
    id: 'agent-researcher',
    kind: 'agent',
    label: 'Researcher',
    summary: 'Fast read-only search agent that answers with evidence.',
    spec: RESEARCHER,
  },
  {
    id: 'agent-test-writer',
    kind: 'agent',
    label: 'Test writer',
    summary: 'Writes and runs unit tests for changed code.',
    spec: TEST_WRITER,
  },
  {
    id: 'skill-basic',
    kind: 'skill',
    label: 'Basic skill',
    summary: 'Instructions plus injected shell output.',
    spec: BASIC_SKILL,
  },
  {
    id: 'skill-arguments',
    kind: 'skill',
    label: 'Skill with arguments',
    summary: 'User-invoked skill with named arguments and pre-approved tools.',
    spec: ARGUMENTS_SKILL,
  },
];

export function renderTemplate(template: AuthoringTemplate): string {
  return template.kind === 'agent' ? renderAgent(template.spec) : renderSkill(template.spec);
}

export function findTemplate(id: string): AuthoringTemplate | null {
  return TEMPLATES.find((template) => template.id === id) ?? null;
}
