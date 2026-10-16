// Maps raw SDK messages to Overlord events for one session. It keeps the
// session summary, the agent tree and open tool calls, and returns the events
// each message causes. It does no I/O, so the session decides where they go.

import {
  ZERO_USAGE,
  type AgentNode,
  type FeedItem,
  type PermissionMode,
  type SessionState,
  type SessionSummary,
  type ToolCall,
} from '../../shared/model.js';
import type { RateLimits } from '../../shared/protocol.js';

import {
  addUsage,
  parsePermissionMode,
  preview,
  toTokenUsage,
  type EndReason,
  type SessionEvent,
  type SessionInfo,
} from './events.js';
import {
  assistantBlocks,
  parseSdkMessage,
  toolResults,
  type AssistantMessage,
  type InitMessage,
  type RateLimitMessage,
  type ResultMessage,
  type SdkEvent,
  type TaskNotificationMessage,
  type TaskStartedMessage,
} from './messages.js';
import {
  NO_RATE_LIMITS,
  applyRateLimit,
  initialSummary,
  mainAgent,
  subagent,
  type MapperConfig,
} from './nodes.js';

export type { MapperConfig } from './nodes.js';

type SystemMessage = Extract<SdkEvent, { readonly type: 'system' }>;
type FeedBody = FeedItem extends infer T
  ? T extends FeedItem
    ? Omit<T, 'id' | 'at'>
    : never
  : never;

export class MessageMapper {
  private readonly sessionId: string;
  private readonly now: () => number;
  private current: SessionSummary;
  private readonly agents = new Map<string, AgentNode>();
  private readonly tools = new Map<string, ToolCall>();
  private readonly taskByToolUse = new Map<string, string>();
  private readonly seenMessages = new Set<string>();
  private feedSeq = 0;
  private limits: RateLimits = NO_RATE_LIMITS;
  private sessionInfo: SessionInfo | null = null;

  constructor(config: MapperConfig) {
    this.sessionId = config.sessionId;
    this.now = config.now;
    const at = config.now();
    this.current = initialSummary(config, at);
    this.agents.set(config.sessionId, mainAgent(config, at));
  }

  summary(): SessionSummary {
    return this.current;
  }

  info(): SessionInfo | null {
    return this.sessionInfo;
  }

  agentList(): readonly AgentNode[] {
    return [...this.agents.values()];
  }

  started(): SessionEvent[] {
    return [this.summaryEvent({}), ...this.agentEvent(this.sessionId, {})];
  }

  prompted(text: string): SessionEvent[] {
    return [this.feed(this.sessionId, [{ kind: 'user', text }]), ...this.setState('running')];
  }

  /** Called when the count of open permission prompts changes. */
  waiting(open: number): SessionEvent[] {
    if (this.current.state !== 'running' && this.current.state !== 'waiting') {
      return [];
    }
    return this.setState(open > 0 ? 'waiting' : 'running');
  }

  modelChanged(model: string): SessionEvent[] {
    return [this.summaryEvent({ model }), ...this.agentEvent(this.sessionId, { model })];
  }

  permissionModeChanged(permissionMode: PermissionMode): SessionEvent[] {
    return [this.summaryEvent({ permissionMode })];
  }

  contextMeasured(contextFill: number): SessionEvent[] {
    return [this.summaryEvent({ contextFill })];
  }

  ended(reason: EndReason): SessionEvent[] {
    const state = this.endState(reason);
    return [
      this.summaryEvent({ state }),
      ...this.agentEvent(this.sessionId, { state, endedAt: this.now(), currentTool: null }),
    ];
  }

  translate(raw: unknown): SessionEvent[] {
    const message = parseSdkMessage(raw);
    if (message === null) {
      return [];
    }
    switch (message.type) {
      case 'system': {
        return this.system(message);
      }
      case 'assistant': {
        return this.assistant(message);
      }
      case 'user': {
        return this.user(message.message.content);
      }
      case 'result': {
        return this.result(message);
      }
      case 'rate_limit_event': {
        return this.rateLimit(message);
      }
    }
  }

  private endState(reason: EndReason): SessionState {
    if (reason === 'failed') {
      return 'failed';
    }
    if (reason === 'completed' && this.current.state === 'failed') {
      return 'failed';
    }
    return 'done';
  }

  private system(message: SystemMessage): SessionEvent[] {
    switch (message.subtype) {
      case 'init': {
        return this.init(message);
      }
      case 'task_started': {
        return this.taskStarted(message);
      }
      case 'task_notification': {
        return this.taskNotification(message);
      }
      case 'compact_boundary': {
        const at = this.now();
        return [
          {
            name: 'compaction.recorded',
            payload: { sessionId: this.sessionId, agentId: this.sessionId, at },
          },
          this.feed(this.sessionId, [
            {
              kind: 'system',
              text: `Context compacted (${message.compact_metadata.trigger}, ${String(message.compact_metadata.pre_tokens)} tokens before)`,
            },
          ]),
        ];
      }
    }
  }

  private init(message: InitMessage): SessionEvent[] {
    const first = this.sessionInfo === null;
    this.sessionInfo = {
      model: message.model,
      cwd: message.cwd,
      tools: message.tools,
      permissionMode: message.permissionMode,
      mcpServers: message.mcp_servers,
      version: message.claude_code_version ?? null,
    };
    const events: SessionEvent[] = [
      this.summaryEvent({
        model: message.model,
        cwd: message.cwd,
        permissionMode: parsePermissionMode(message.permissionMode) ?? this.current.permissionMode,
        version: message.claude_code_version ?? this.current.version,
      }),
      ...this.agentEvent(this.sessionId, { model: message.model }),
    ];
    if (first) {
      const servers = message.mcp_servers.map((server) => `${server.name} (${server.status})`);
      const text = `Started ${message.model} in ${message.cwd} with ${String(message.tools.length)} tools; MCP: ${servers.length > 0 ? servers.join(', ') : 'none'}`;
      events.push(this.feed(this.sessionId, [{ kind: 'system', text }]));
    }
    return events;
  }

  private agentFor(agentId: string | undefined, parentToolUseId: string | null): string {
    const viaTool = parentToolUseId === null ? undefined : this.taskByToolUse.get(parentToolUseId);
    return agentId ?? viaTool ?? this.sessionId;
  }

  private assistant(message: AssistantMessage): SessionEvent[] {
    const agentId = this.agentFor(message.agent_id, message.parent_tool_use_id);
    const events: SessionEvent[] = [];
    const body = message.message;
    if (!this.seenMessages.has(body.id)) {
      this.seenMessages.add(body.id);
      const usage =
        body.usage === null || body.usage === undefined ? ZERO_USAGE : toTokenUsage(body.usage);
      events.push({
        name: 'request.recorded',
        payload: {
          messageId: body.id,
          requestId: message.request_id ?? null,
          sessionId: this.sessionId,
          agentId,
          model: body.model,
          timestamp: this.now(),
          usage,
          ttftMs: null,
          durationMs: null,
          costUsd: null,
        },
      });
      const agent = this.agents.get(agentId);
      if (agent !== undefined) {
        events.push(...this.agentEvent(agentId, { usage: addUsage(agent.usage, usage) }));
      }
    }
    const items: FeedBody[] = [];
    for (const block of assistantBlocks(body.content)) {
      switch (block.type) {
        case 'text': {
          items.push({ kind: 'text', text: block.text });
          break;
        }
        case 'thinking': {
          items.push({ kind: 'thinking', text: block.thinking });
          break;
        }
        case 'tool_use': {
          items.push({ kind: 'tool_use', name: block.name, input: block.input });
          events.push(...this.toolStarted(agentId, block.id, block.name, block.input));
          break;
        }
      }
    }
    if (items.length > 0) {
      events.push(this.feed(agentId, items));
    }
    return events;
  }

  private toolStarted(agentId: string, id: string, name: string, input: unknown): SessionEvent[] {
    const call: ToolCall = {
      id,
      sessionId: this.sessionId,
      agentId,
      name,
      input,
      startedAt: this.now(),
      endedAt: null,
      ok: null,
      resultPreview: null,
    };
    this.tools.set(id, call);
    const agent = this.agents.get(agentId);
    const count = agent === undefined ? 0 : agent.toolCallCount + 1;
    return [
      { name: 'tool.upserted', payload: call },
      ...this.agentEvent(agentId, { toolCallCount: count, currentTool: name }),
    ];
  }

  private user(content: string | readonly unknown[]): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const result of toolResults(content)) {
      const call = this.tools.get(result.toolUseId);
      const agentId = call?.agentId ?? this.sessionId;
      if (call !== undefined) {
        const finished: ToolCall = {
          ...call,
          endedAt: this.now(),
          ok: result.ok,
          resultPreview: preview(result.text),
        };
        this.tools.set(call.id, finished);
        events.push(
          { name: 'tool.upserted', payload: finished },
          ...this.agentEvent(agentId, { currentTool: null }),
        );
      }
      events.push(
        this.feed(agentId, [
          { kind: 'tool_result', toolUseId: result.toolUseId, ok: result.ok, text: result.text },
        ]),
      );
    }
    return events;
  }

  private result(message: ResultMessage): SessionEvent[] {
    const usage = toTokenUsage(message.usage);
    const ok = !message.is_error;
    const text = message.result ?? message.errors?.join('; ') ?? null;
    const state: SessionState = ok ? 'done' : 'failed';
    const events: SessionEvent[] = [
      this.summaryEvent({
        state,
        costUsd: message.total_cost_usd,
        usage: addUsage(this.current.usage, usage),
      }),
      ...this.agentEvent(this.sessionId, { state, currentTool: null }),
    ];
    if (!ok) {
      events.push(
        this.feed(this.sessionId, [
          { kind: 'system', text: `Turn failed (${message.subtype}): ${text ?? ''}` },
        ]),
      );
    }
    events.push({
      name: 'turn.result',
      payload: {
        ok,
        subtype: message.subtype,
        text,
        costUsd: message.total_cost_usd,
        turns: message.num_turns,
        durationMs: message.duration_ms,
        usage,
      },
    });
    return events;
  }

  private taskStarted(message: TaskStartedMessage): SessionEvent[] {
    const node = subagent(this.sessionId, message, this.now());
    this.agents.set(node.id, node);
    if (message.tool_use_id !== undefined) {
      this.taskByToolUse.set(message.tool_use_id, node.id);
    }
    return [
      { name: 'agent.upserted', payload: node },
      this.summaryEvent({ agentCount: this.agents.size - 1 }),
    ];
  }

  private taskNotification(message: TaskNotificationMessage): SessionEvent[] {
    return this.agentEvent(message.task_id, {
      state: message.status === 'failed' ? 'failed' : 'done',
      endedAt: this.now(),
      currentTool: null,
    });
  }

  private rateLimit(message: RateLimitMessage): SessionEvent[] {
    const next = applyRateLimit(this.limits, message);
    if (next === null) {
      return [];
    }
    this.limits = next;
    return [{ name: 'rateLimits.updated', payload: next }];
  }

  private setState(state: SessionState): SessionEvent[] {
    return [this.summaryEvent({ state }), ...this.agentEvent(this.sessionId, { state })];
  }

  private summaryEvent(patch: Partial<SessionSummary>): SessionEvent {
    this.current = { ...this.current, ...patch, updatedAt: this.now() };
    return { name: 'session.upserted', payload: this.current };
  }

  private agentEvent(agentId: string, patch: Partial<AgentNode>): SessionEvent[] {
    const agent = this.agents.get(agentId);
    if (agent === undefined) {
      return [];
    }
    const next: AgentNode = { ...agent, ...patch };
    this.agents.set(agentId, next);
    return [{ name: 'agent.upserted', payload: next }];
  }

  private feed(agentId: string, bodies: readonly FeedBody[]): SessionEvent {
    const at = this.now();
    const items = bodies.map((body): FeedItem => {
      this.feedSeq += 1;
      return { ...body, id: `${this.sessionId}:${String(this.feedSeq)}`, at };
    });
    return { name: 'feed.appended', payload: { sessionId: this.sessionId, agentId, items } };
  }
}
