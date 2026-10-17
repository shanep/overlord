// One thread of a Copilot session (the main agent or a subagent): its open
// turn, tool calls and feed, and how its events become feed items.

import type { FeedItem, SessionState, ToolCall } from '../../../shared/model.js';
import { preview } from '../../transcripts/text.js';

import type {
  AssistantMessage,
  SubagentEnd,
  SubagentStart,
  ToolComplete,
  ToolStart,
} from './events.js';

export interface Thread {
  readonly id: string;
  /** The tool call that started a subagent, or null for the main thread. */
  readonly parentToolUseId: string | null;
  readonly parentAgentId: string | null;
  readonly spawnDepth: number;
  readonly agentType: string;
  readonly description: string;
  readonly background: boolean;
  model: string | null;
  firstAt: number | null;
  lastAt: number | null;
  endedAt: number | null;
  outcome: 'done' | 'failed' | null;
  /** A turn is open: a prompt came in and the model has not finished answering. */
  open: boolean;
  /** The latest model call asked for tools, so its turn_end is not the end of the answer. */
  wantsTools: boolean;
  readonly tools: Map<string, ToolCall>;
  readonly feed: FeedItem[];
  readonly fedTools: Set<string>;
}

/** What subagent.started says about a new thread. */
export interface ThreadStart {
  readonly toolCallId: string;
  readonly agentType: string;
  readonly description: string;
  readonly background: boolean;
}

export function mainThread(id: string): Thread {
  return {
    id,
    parentToolUseId: null,
    parentAgentId: null,
    spawnDepth: 0,
    agentType: 'main',
    description: '',
    background: false,
    model: null,
    firstAt: null,
    lastAt: null,
    endedAt: null,
    outcome: null,
    open: false,
    wantsTools: false,
    tools: new Map(),
    feed: [],
    fedTools: new Set(),
  };
}

/** A subagent's thread. Without a start event its type and description are unknown. */
export function childThread(id: string, parent: Thread, start: ThreadStart | null): Thread {
  return {
    ...mainThread(id),
    parentToolUseId: start?.toolCallId ?? null,
    parentAgentId: parent.id,
    spawnDepth: parent.spawnDepth + 1,
    agentType: start?.agentType ?? 'unknown',
    description: start?.description ?? '',
    background: start?.background ?? false,
    tools: new Map(),
    feed: [],
    fedTools: new Set(),
  };
}

export function threadState(thread: Thread, now: number, windowMs: number): SessionState {
  if (thread.outcome !== null) {
    return thread.outcome;
  }
  if (thread.lastAt === null) {
    return 'unknown';
  }
  return thread.open && now - thread.lastAt <= windowMs ? 'running' : 'idle';
}

/** Adds items to a thread's feed, dropping the oldest past the limit, and returns them. */
export function pushFeed(thread: Thread, items: readonly FeedItem[], limit: number): FeedItem[] {
  thread.feed.push(...items);
  if (thread.feed.length > limit) {
    thread.feed.splice(0, thread.feed.length - limit);
  }
  return [...items];
}

/** Reasoning, text and tool requests of one assistant.message, in that order. */
export function messageItems(thread: Thread, data: AssistantMessage, at: number): FeedItem[] {
  const items: FeedItem[] = [];
  const reasoning = data.reasoningText ?? '';
  if (reasoning !== '') {
    items.push({ kind: 'thinking', id: `${data.messageId}:thinking`, at, text: reasoning });
  }
  if (data.content !== '') {
    items.push({ kind: 'text', id: `${data.messageId}:text`, at, text: data.content });
  }
  for (const tool of data.toolRequests) {
    if (tool !== null) {
      thread.fedTools.add(tool.toolCallId);
      items.push({
        kind: 'tool_use',
        id: tool.toolCallId,
        at,
        name: tool.name,
        input: tool.arguments,
      });
    }
  }
  return items;
}

/** Where a tool call belongs and how much of its result to keep. */
export interface ToolContext {
  readonly sessionId: string;
  readonly at: number;
  readonly previewChars: number;
}

/** A tool call no event has said anything about yet. */
function blankTool(thread: Thread, id: string, context: ToolContext): ToolCall {
  return {
    id,
    sessionId: context.sessionId,
    agentId: thread.id,
    name: 'tool',
    input: null,
    startedAt: context.at,
    endedAt: null,
    ok: null,
    resultPreview: null,
  };
}

/** The tool call a tool.execution_start opens, and its feed item when no message listed it. */
export function startTool(
  thread: Thread,
  data: ToolStart,
  context: ToolContext,
): { readonly tool: ToolCall; readonly items: FeedItem[] } {
  const known = thread.tools.get(data.toolCallId) ?? blankTool(thread, data.toolCallId, context);
  const tool: ToolCall = { ...known, name: data.toolName, input: data.arguments ?? known.input };
  thread.tools.set(tool.id, tool);
  if (thread.fedTools.has(tool.id)) {
    return { tool, items: [] };
  }
  thread.fedTools.add(tool.id);
  const { at } = context;
  return {
    tool,
    items: [{ kind: 'tool_use', id: tool.id, at, name: tool.name, input: tool.input }],
  };
}

/** A denied tool fails with error.code "denied", one the user turned down with "rejected". */
export function finishTool(
  thread: Thread,
  data: ToolComplete,
  context: ToolContext,
): { readonly tool: ToolCall; readonly item: FeedItem } {
  const { at } = context;
  const text = preview(data.result?.content ?? data.error?.message ?? '', context.previewChars);
  const known = thread.tools.get(data.toolCallId) ?? blankTool(thread, data.toolCallId, context);
  const tool: ToolCall = { ...known, endedAt: at, ok: data.success, resultPreview: text };
  thread.tools.set(tool.id, tool);
  const item: FeedItem = {
    kind: 'tool_result',
    id: `${tool.id}:result`,
    at,
    toolUseId: tool.id,
    ok: data.success,
    text,
  };
  return { tool, item };
}

/** The thread a subagent.started opens, keyed by the tool call that spawned it. */
export function startSubagent(parent: Thread, data: SubagentStart, at: number): Thread {
  const thread = childThread(data.toolCallId, parent, {
    toolCallId: data.toolCallId,
    agentType: data.agentName,
    description: data.agentDescription ?? data.agentDisplayName ?? '',
    background: data.executionMode === 'background',
  });
  thread.model = data.model ?? null;
  thread.firstAt = at;
  thread.lastAt = at;
  thread.open = true;
  return thread;
}

export function endSubagent(thread: Thread, data: SubagentEnd, failed: boolean, at: number): void {
  thread.model = data.model ?? thread.model;
  thread.open = false;
  thread.endedAt = at;
  thread.lastAt = Math.max(thread.lastAt ?? at, at);
  thread.outcome = failed ? 'failed' : 'done';
}
