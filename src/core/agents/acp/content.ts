// Small readers for ACP payloads: the text a block or a tool result shows,
// a tool's name and input, plans, and the agent's config options.

import type {
  ContentBlock as AcpContentBlock,
  PlanEntry,
  SessionConfigOption,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';

/** The text an ACP content block shows in the feed. */
export function blockText(block: AcpContentBlock): string {
  switch (block.type) {
    case 'text': {
      return block.text;
    }
    case 'resource_link': {
      return block.uri;
    }
    case 'resource': {
      return 'text' in block.resource ? block.resource.text : block.resource.uri;
    }
    case 'image':
    case 'audio': {
      return `[${block.type}]`;
    }
  }
}

function contentText(content: ToolCallContent): string {
  switch (content.type) {
    case 'content': {
      return blockText(content.content);
    }
    case 'diff': {
      return `Edited ${content.path}`;
    }
    case 'terminal': {
      return `Terminal ${content.terminalId}`;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a finished call returned, from its content or else its raw output. */
export function resultText(update: ToolCallUpdate): string {
  const parts = (update.content ?? []).map((content) => contentText(content));
  if (parts.length > 0) {
    return parts.join('\n');
  }
  const raw = update.rawOutput;
  if (typeof raw === 'string') {
    return raw;
  }
  if (isRecord(raw) && typeof raw['message'] === 'string') {
    return raw['message'];
  }
  return raw === undefined || raw === null ? '' : JSON.stringify(raw);
}

/** The tool's name: what the agent calls it, or else its kind. */
export function toolName(call: ToolCallUpdate): string | null {
  return call.name ?? call.kind ?? null;
}

/** Tool input as a record, since the inbox and rules read named fields. */
export function inputRecord(input: unknown): Record<string, unknown> {
  if (isRecord(input)) {
    return input;
  }
  return input === undefined || input === null ? {} : { value: input };
}

const PLAN_MARKS = { pending: ' ', in_progress: '~', completed: 'x' } as const;

export function planText(entries: readonly PlanEntry[]): string {
  const lines = entries.map((entry) => `- [${PLAN_MARKS[entry.status]}] ${entry.content}`);
  return ['Plan:', ...lines].join('\n');
}

/** The current value of the agent's config option in a category, such as model or mode. */
export function configValue(
  options: readonly SessionConfigOption[],
  category: string,
): { readonly id: string; readonly value: string } | null {
  const option = options.find((candidate) => candidate.category === category);
  if (option?.type !== 'select') {
    return null;
  }
  return { id: option.id, value: option.currentValue };
}
