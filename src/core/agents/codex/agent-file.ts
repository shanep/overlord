// Codex CLI's custom agents: one standalone TOML file each, in
// $CODEX_HOME/agents or a project's .codex/agents, from the subagents page of
// the Codex docs (read 2026-10-17). name, description and
// developer_instructions are required, and name, not the file name, is the
// agent's id. These files are separate from config.toml, so writing one never
// touches the user's config.toml.

import { parse } from 'smol-toml';

import { isRecord, parseFrontmatter } from '../../authoring/frontmatter.js';
import type { AgentSpec } from '../../authoring/schema.js';
import type { AuthoringIssue } from '../../authoring/validate.js';

export const CODEX_AGENT_SUFFIX = '.toml';

const REQUIRED = ['name', 'description', 'developer_instructions'] as const;

/** Keys the docs list, written in this order. Anything else goes after them. */
const KNOWN: readonly string[] = [
  ...REQUIRED,
  'nickname_candidates',
  'model',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'sandbox_mode',
  'mcp_servers',
  'skills',
  'features',
];

/** Keys a draft's frontmatter may carry over, all plain strings. */
const DRAFT_KEYS: readonly string[] = ['model', 'model_reasoning_effort', 'sandbox_mode'];

const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
]);

/** A TOML basic string, or a multi-line one for text with line breaks. */
function tomlString(value: string): string {
  if (!value.includes('\n')) {
    // JSON's escapes are all valid in a TOML basic string.
    return JSON.stringify(value);
  }
  const escaped = value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('\r', String.raw`\r`)
    .replaceAll('"""', String.raw`""\"`);
  // A newline right after the opening quotes is dropped by TOML readers.
  return `"""\n${escaped}"""`;
}

function tomlValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return tomlString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return `[${value.map((item: string) => tomlString(item)).join(', ')}]`;
  }
  return null;
}

/**
 * The agent as TOML. Plain values come first in the documented order. Tables
 * and anything else this writer does not handle are left out, since a new
 * agent file never has them.
 */
function renderToml(table: Readonly<Record<string, unknown>>): string {
  const keys = [...KNOWN, ...Object.keys(table).filter((key) => !KNOWN.includes(key))];
  const lines: string[] = [];
  for (const key of keys) {
    const value = tomlValue(table[key]);
    if (value !== null) {
      lines.push(`${key} = ${value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function body(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed === '' ? '' : `${trimmed}\n`;
}

/**
 * A Claude Code template as a Codex agent. The model is left out, since
 * Claude's aliases mean nothing to Codex, and an agent whose tools cannot
 * edit or run commands gets a read-only sandbox.
 */
export function renderCodexAgent(spec: AgentSpec): string {
  const { tools } = spec.frontmatter;
  const list = typeof tools === 'string' ? tools.split(/[\s,]+/u) : (tools ?? []);
  const readOnly = tools !== undefined && !list.some((tool) => EDIT_TOOLS.has(tool.trim()));
  return renderToml({
    name: spec.frontmatter.name,
    description: spec.frontmatter.description,
    developer_instructions: body(spec.body),
    ...(readOnly ? { sandbox_mode: 'read-only' } : {}),
  });
}

function parseTable(text: string): Record<string, unknown> | null {
  try {
    const table: unknown = parse(text);
    return isRecord(table) ? table : null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateCodexAgent(text: string): readonly AuthoringIssue[] {
  let table: unknown;
  try {
    table = parse(text);
  } catch (error) {
    return [{ severity: 'error', field: null, message: `Not valid TOML: ${messageOf(error)}` }];
  }
  if (!isRecord(table)) {
    return [{ severity: 'error', field: null, message: 'The file must be a TOML table.' }];
  }
  const issues: AuthoringIssue[] = [];
  for (const key of REQUIRED) {
    const value = table[key];
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push({
        severity: 'error',
        field: key,
        message:
          value === undefined
            ? `${key} is required.`
            : `${key} must be a string that is not empty.`,
      });
    }
  }
  for (const key of Object.keys(table).filter((name) => !KNOWN.includes(name))) {
    issues.push({
      severity: 'warning',
      field: key,
      message: `Unknown key "${key}". Codex CLI may not read it.`,
    });
  }
  return issues;
}

/** A drafted Markdown agent as a Codex table: its frontmatter fields and its body as the instructions. */
function fromDraft(text: string): Record<string, unknown> | null {
  const split = parseFrontmatter(text);
  if (!split.ok) {
    return null;
  }
  const out: Record<string, unknown> = {
    name: split.data['name'],
    description: split.data['description'],
    developer_instructions: body(split.body),
  };
  for (const key of DRAFT_KEYS) {
    const value = split.data[key];
    if (typeof value === 'string' && value !== '') {
      out[key] = value;
    }
  }
  return out;
}

/** True when renderToml can write every value, so nothing is lost. */
function plain(table: Readonly<Record<string, unknown>>): boolean {
  return Object.values(table).every((value) => value === undefined || tomlValue(value) !== null);
}

/**
 * The file with its name set. Takes a TOML file, or a draft written as
 * Markdown with frontmatter, which becomes TOML. A file with tables, like
 * [mcp_servers], and anything else comes back as it is, so nothing is lost.
 */
export function codexAgentWithName(text: string, name: string): string {
  const table = parseTable(text) ?? fromDraft(text);
  return table === null || !plain(table) ? text : renderToml({ ...table, name });
}

/** The name field of a TOML agent file, or null. */
export function codexAgentName(text: string): string | null {
  const name = parseTable(text)?.['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

export const CODEX_AGENT_GUIDE = `Write a Codex CLI custom agent (saved as .codex/agents/<name>.toml). It is for Codex CLI, not Claude Code. Write it as Markdown with YAML frontmatter, and Overlord turns it into Codex's TOML file.

Frontmatter fields:
- name (required): lowercase letters, digits and hyphens, such as code-reviewer.
- description (required): what the agent does and when Codex should hand it work.
- model: a Codex model id. Leave it out to use the parent session's model.
- model_reasoning_effort: low, medium, high or xhigh.
- sandbox_mode: read-only for an agent that only reads, workspace-write for one that edits files.

The body after the frontmatter becomes the agent's developer_instructions. Write it in the second person, say what to do step by step, and say what to report back.`;
