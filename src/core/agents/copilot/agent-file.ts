// Copilot CLI's custom agent files: <name>.agent.md with YAML frontmatter,
// from docs.github.com/en/copilot/reference/custom-agents-configuration
// (read 2026-10-17). Only description is required, the body is the agent's
// prompt and can be at most 30,000 characters, and the file name without
// .agent.md is the agent's id.

import { z } from 'zod';

import { joinFrontmatter, parseFrontmatter } from '../../authoring/frontmatter.js';
import type { AgentSpec } from '../../authoring/schema.js';
import { nameProblems } from '../../authoring/schema.js';
import type { AuthoringIssue } from '../../authoring/validate.js';

export const COPILOT_AGENT_SUFFIX = '.agent.md';
export const COPILOT_PROMPT_LIMIT = 30_000;

const text = z.string({ error: 'Expected a string.' });
const flag = z.boolean({ error: 'Expected true or false.' });

const copilotAgentSchema = z.object({
  name: text
    .superRefine((value, context) => {
      for (const message of nameProblems('agent', value)) {
        context.addIssue({ code: 'custom', message });
      }
    })
    .optional(),
  description: z
    .string({
      error: (issue) =>
        issue.input === undefined ? 'description is required.' : 'description must be a string.',
    })
    .min(1, { error: 'description cannot be empty.' }),
  target: z
    .enum(['vscode', 'github-copilot'], { error: 'target must be vscode or github-copilot.' })
    .optional(),
  tools: z
    .union([z.string(), z.array(z.string())], {
      error: 'Expected a comma-separated string or a list of tool names.',
    })
    .optional(),
  model: text.min(1).optional(),
  'disable-model-invocation': flag.optional(),
  'user-invocable': flag.optional(),
  infer: flag.optional(),
  'mcp-servers': z
    .record(z.string(), z.unknown(), { error: 'mcp-servers must be a map.' })
    .optional(),
  metadata: z
    .record(z.string(), z.string(), { error: 'metadata must be a map of names to strings.' })
    .optional(),
});

type CopilotAgentFrontmatter = z.output<typeof copilotAgentSchema>;

/** The order fields are written in, which is the order the docs list them. */
const FIELDS: readonly (keyof CopilotAgentFrontmatter)[] = [
  'name',
  'description',
  'target',
  'tools',
  'model',
  'disable-model-invocation',
  'user-invocable',
  'infer',
  'mcp-servers',
  'metadata',
];

/**
 * Claude Code tool names to Copilot's tool aliases. A name Copilot does not
 * know is ignored, so a tool with no alias is left out.
 */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  Bash: 'execute',
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  Task: 'agent',
  Agent: 'agent',
  WebFetch: 'web',
  WebSearch: 'web',
  TodoWrite: 'todo',
};

function toolNames(tools: string | readonly string[] | undefined): string[] {
  if (tools === undefined) {
    return [];
  }
  const list = typeof tools === 'string' ? tools.split(/[\s,]+/u) : tools;
  return list.map((tool) => tool.trim()).filter((tool) => tool !== '');
}

/** Copilot's aliases for Claude Code's tools, each once, in first-seen order. */
export function copilotTools(claudeTools: string | readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const tool of toolNames(claudeTools)) {
    const alias = TOOL_ALIASES[tool];
    if (alias !== undefined && !out.includes(alias)) {
      out.push(alias);
    }
  }
  return out;
}

function ordered(frontmatter: CopilotAgentFrontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const value = frontmatter[field];
    if (value !== undefined) {
      out[field] = value;
    }
  }
  return out;
}

function render(frontmatter: CopilotAgentFrontmatter, body: string): string {
  return joinFrontmatter(ordered(frontmatter), body);
}

/**
 * A Claude Code template as a Copilot agent. Its model is left out, since
 * Claude's aliases like haiku mean nothing to Copilot, and its tools become
 * Copilot's aliases.
 */
export function renderCopilotAgent(spec: AgentSpec): string {
  const tools = copilotTools(spec.frontmatter.tools);
  return render(
    {
      name: spec.frontmatter.name,
      description: spec.frontmatter.description,
      ...(tools.length === 0 ? {} : { tools }),
    },
    spec.body,
  );
}

function issuesOf(error: z.ZodError): AuthoringIssue[] {
  return error.issues.map((issue) => ({
    severity: 'error',
    field: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function warnings(data: Readonly<Record<string, unknown>>, body: string): AuthoringIssue[] {
  const known = new Set<string>(FIELDS);
  const out: AuthoringIssue[] = Object.keys(data)
    .filter((key) => !known.has(key))
    .map((key) => ({
      severity: 'warning',
      field: key,
      message: `Unknown field "${key}". Copilot CLI ignores it.`,
    }));
  if (data['infer'] !== undefined) {
    out.push({
      severity: 'warning',
      field: 'infer',
      message: 'infer is retired. Use disable-model-invocation and user-invocable instead.',
    });
  }
  if (body.trim() === '') {
    out.push({
      severity: 'warning',
      field: null,
      message: 'The body is empty, so the agent has no prompt.',
    });
  }
  return out;
}

type Parsed =
  | {
      readonly frontmatter: CopilotAgentFrontmatter;
      readonly body: string;
      readonly issues: AuthoringIssue[];
    }
  | { readonly frontmatter: null; readonly issues: AuthoringIssue[] };

function parse(textValue: string): Parsed {
  const split = parseFrontmatter(textValue);
  if (!split.ok) {
    return {
      frontmatter: null,
      issues: [{ severity: 'error', field: null, message: split.message }],
    };
  }
  const result = copilotAgentSchema.safeParse(split.data);
  const extra = warnings(split.data, split.body);
  const tooLong: AuthoringIssue[] =
    split.body.length > COPILOT_PROMPT_LIMIT
      ? [
          {
            severity: 'error',
            field: null,
            message: `The prompt is ${String(split.body.length)} characters. Copilot CLI takes at most ${String(COPILOT_PROMPT_LIMIT)}.`,
          },
        ]
      : [];
  if (!result.success) {
    return { frontmatter: null, issues: [...issuesOf(result.error), ...tooLong, ...extra] };
  }
  const issues = [...tooLong, ...extra];
  return tooLong.length > 0
    ? { frontmatter: null, issues }
    : { frontmatter: result.data, body: split.body, issues };
}

export function validateCopilotAgent(textValue: string): readonly AuthoringIssue[] {
  return parse(textValue).issues;
}

/** The file text with its name set, when it parses. */
export function copilotAgentWithName(textValue: string, name: string): string {
  const parsed = parse(textValue);
  return parsed.frontmatter === null
    ? textValue
    : render({ ...parsed.frontmatter, name }, parsed.body);
}

export const COPILOT_AGENT_GUIDE = `Write a GitHub Copilot CLI custom agent file (.github/agents/<name>.agent.md). It is for Copilot CLI, not Claude Code.

Frontmatter fields:
- name: the display name, lowercase letters, digits and hyphens, such as code-reviewer.
- description (required): what the agent does and when Copilot should use it.
- tools: a list of tool aliases the agent may use: read, edit, search, execute, web, agent, todo. Leave it out to allow every tool.
- model: a Copilot model id. Leave it out to use the default model.
- disable-model-invocation: true when the user must pick the agent by hand.
- user-invocable: false when only other agents should call it.

The body after the frontmatter is the agent's prompt, at most 30,000 characters. Write it in the second person, say what to do step by step, and say what to report back.`;
