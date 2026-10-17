// The items of a Codex turn as app-server sends them in item/started and
// item/completed, and how each tool item shows in the feed. Tool names and
// inputs match the rollout observer's, so a session reads the same either way.

import { z } from 'zod';

const commandItemSchema = z.object({
  type: z.literal('commandExecution'),
  id: z.string(),
  command: z.string(),
  cwd: z.string().nullish(),
  status: z.string(),
  aggregatedOutput: z.string().nullish(),
  exitCode: z.number().nullish(),
});

const fileChangeItemSchema = z.object({
  type: z.literal('fileChange'),
  id: z.string(),
  changes: z.array(
    z.object({
      path: z.string(),
      kind: z.object({ type: z.string() }),
      diff: z.string().nullish(),
    }),
  ),
  status: z.string(),
});

const mcpItemSchema = z.object({
  type: z.literal('mcpToolCall'),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
  status: z.string(),
  result: z.object({ content: z.array(z.unknown()) }).nullish(),
  error: z.object({ message: z.string() }).nullish(),
});

export const itemSchema = z.discriminatedUnion('type', [
  commandItemSchema,
  fileChangeItemSchema,
  mcpItemSchema,
  z.object({ type: z.literal('agentMessage'), id: z.string(), text: z.string() }),
  z.object({
    type: z.literal('reasoning'),
    id: z.string(),
    summary: z.array(z.string()).catch([]),
    content: z.array(z.string()).catch([]),
  }),
  z.object({ type: z.literal('contextCompaction'), id: z.string() }),
]);

export type Item = z.infer<typeof itemSchema>;
export type ToolItem = Extract<
  Item,
  { readonly type: 'commandExecution' | 'fileChange' | 'mcpToolCall' }
>;

/** `/bin/zsh -lc 'touch a.txt'` gives `touch a.txt`. Anything else stays as it is. */
export function shellScript(command: string): string {
  const match = /^\S*sh -lc (?<rest>.+)$/su.exec(command);
  const rest = match?.groups?.['rest'];
  if (rest === undefined) {
    return command;
  }
  return rest.length > 1 && rest.startsWith("'") && rest.endsWith("'")
    ? rest.slice(1, -1).replaceAll(String.raw`'\''`, "'")
    : rest;
}

/** The tool name and input an item shows as, the same ones the rollout observer uses. */
export interface ItemTool {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export function itemTool(item: ToolItem): ItemTool {
  switch (item.type) {
    case 'commandExecution': {
      return {
        name: 'exec_command',
        input: { command: shellScript(item.command), cwd: item.cwd ?? null },
      };
    }
    case 'fileChange': {
      return {
        name: 'apply_patch',
        input: {
          changes: item.changes.map((change) => ({
            path: change.path,
            kind: change.kind.type,
            diff: change.diff ?? null,
          })),
        },
      };
    }
    case 'mcpToolCall': {
      const input =
        typeof item.arguments === 'object' && item.arguments !== null ? item.arguments : {};
      return { name: `mcp__${item.server}__${item.tool}`, input: { ...input } };
    }
  }
}

function contentText(content: readonly unknown[]): string {
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
        ? part.text
        : JSON.stringify(part),
    )
    .join('\n');
}

interface Outcome {
  readonly ok: boolean;
  readonly text: string;
}

function commandOutcome(item: Extract<ToolItem, { readonly type: 'commandExecution' }>): Outcome {
  const declined = item.status === 'declined';
  return {
    ok: item.status === 'completed' && (item.exitCode ?? 0) === 0,
    text: item.aggregatedOutput ?? (declined ? 'Declined' : ''),
  };
}

function fileOutcome(item: Extract<ToolItem, { readonly type: 'fileChange' }>): Outcome {
  const files = item.changes.map((change) => `${change.kind.type} ${change.path}`).join('\n');
  return { ok: item.status === 'completed', text: item.status === 'declined' ? 'Declined' : files };
}

function mcpOutcome(item: Extract<ToolItem, { readonly type: 'mcpToolCall' }>): Outcome {
  return {
    ok: item.status === 'completed' && (item.error ?? null) === null,
    text: item.error?.message ?? contentText(item.result?.content ?? []),
  };
}

/** Whether a finished tool item worked, and the text its result shows. */
export function toolOutcome(item: ToolItem): Outcome {
  switch (item.type) {
    case 'commandExecution': {
      return commandOutcome(item);
    }
    case 'fileChange': {
      return fileOutcome(item);
    }
    case 'mcpToolCall': {
      return mcpOutcome(item);
    }
  }
}

const TOOL_TYPES: ReadonlySet<string> = new Set(['commandExecution', 'fileChange', 'mcpToolCall']);

export function isToolItem(item: Item): item is ToolItem {
  return TOOL_TYPES.has(item.type);
}
