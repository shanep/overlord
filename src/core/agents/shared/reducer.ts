// Folds one session's agent events into Overlord events. It keeps the session
// summary, the agent tree and open tool calls, and returns the events each
// agent event causes. It does no I/O, so the session decides where they go.
// Every runtime shares it, so each one only translates its wire format.

import {
  ZERO_USAGE,
  type AgentNode,
  type ApiRequest,
  type FeedItem,
  type SessionState,
  type SessionSummary,
  type ToolCall,
} from '../../../shared/model.js';
import type { RateLimits } from '../../../shared/protocol.js';
import {
  addUsage,
  preview,
  type EndReason,
  type SessionEvent,
  type SessionInfo,
} from '../../harness/events.js';
import {
  NO_RATE_LIMITS,
  applyRateLimit,
  endState,
  initialSummary,
  mainAgent,
  subagent,
  type MapperConfig,
} from '../../harness/nodes.js';

import type {
  AgentEvent,
  CompactedEvent,
  InitEvent,
  MessageEvent,
  RateLimitEvent,
  SubagentEndedEvent,
  SubagentStartedEvent,
  ToolResultEvent,
  TurnResultEvent,
  UsageEvent,
} from './events.js';

type FeedBody = FeedItem extends infer T
  ? T extends FeedItem
    ? Omit<T, 'id' | 'at'>
    : never
  : never;

/** Things the agent reports outside a turn's messages. */
type Reported = Extract<
  AgentEvent,
  { readonly type: 'model_changed' | 'mode_changed' | 'context' | 'notice' }
>;

const REPORTED: ReadonlySet<AgentEvent['type']> = new Set<Reported['type']>([
  'model_changed',
  'mode_changed',
  'context',
  'notice',
]);

function isReported(event: AgentEvent): event is Reported {
  return REPORTED.has(event.type);
}

export class SessionReducer {
  readonly sessionId: string;
  private readonly now: () => number;
  private current: SessionSummary;
  private readonly agents = new Map<string, AgentNode>();
  private readonly tools = new Map<string, ToolCall>();
  private readonly taskByToolUse = new Map<string, string>();
  private readonly recorded = new Set<string>();
  private feedSeq = 0;
  private turns = 0;
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

  permissionModeChanged(permissionMode: string): SessionEvent[] {
    return [this.summaryEvent({ permissionMode })];
  }

  contextMeasured(contextFill: number): SessionEvent[] {
    return [this.summaryEvent({ contextFill })];
  }

  ended(reason: EndReason): SessionEvent[] {
    const state = endState(reason, this.current.state);
    return [
      this.summaryEvent({ state }),
      ...this.agentEvent(this.sessionId, { state, endedAt: this.now(), currentTool: null }),
    ];
  }

  apply(event: AgentEvent): SessionEvent[] {
    return isReported(event) ? this.reported(event) : this.turnEvent(event);
  }

  /** What happens during a turn: messages, tools, subagents and its end. */
  private turnEvent(event: Exclude<AgentEvent, Reported>): SessionEvent[] {
    switch (event.type) {
      case 'init': {
        return this.init(event);
      }
      case 'message': {
        return this.message(event);
      }
      case 'usage': {
        return this.usage(event);
      }
      case 'tool_result': {
        return this.toolResult(event);
      }
      case 'subagent_started': {
        return this.subagentStarted(event);
      }
      case 'subagent_ended': {
        return this.subagentEnded(event);
      }
      case 'compacted': {
        return this.compacted(event);
      }
      case 'rate_limit': {
        return this.rateLimit(event);
      }
      case 'turn_result': {
        return this.turnResult(event);
      }
    }
  }

  private reported(event: Reported): SessionEvent[] {
    switch (event.type) {
      case 'model_changed': {
        return this.modelChanged(event.model);
      }
      case 'mode_changed': {
        return this.permissionModeChanged(event.permissionMode);
      }
      case 'context': {
        return this.contextMeasured(event.maxTokens > 0 ? event.usedTokens / event.maxTokens : 0);
      }
      case 'notice': {
        return [this.feed(this.sessionId, [{ kind: 'system', text: event.text }])];
      }
    }
  }

  private init(event: InitEvent): SessionEvent[] {
    const first = this.sessionInfo === null;
    this.sessionInfo = {
      model: event.model,
      cwd: event.cwd,
      tools: event.tools,
      permissionMode: event.permissionMode,
      mcpServers: event.mcpServers,
      version: event.version,
    };
    const events: SessionEvent[] = [
      this.summaryEvent({
        model: event.model,
        cwd: event.cwd,
        permissionMode: event.permissionMode ?? this.current.permissionMode,
        version: event.version ?? this.current.version,
      }),
      ...this.agentEvent(this.sessionId, { model: event.model }),
    ];
    if (first) {
      const servers = event.mcpServers.map((server) => `${server.name} (${server.status})`);
      const text = `Started ${event.model} in ${event.cwd} with ${String(event.tools.length)} tools; MCP: ${servers.length > 0 ? servers.join(', ') : 'none'}`;
      events.push(this.feed(this.sessionId, [{ kind: 'system', text }]));
    }
    return events;
  }

  private agentFor(agentId: string | null, parentToolUseId: string | null): string {
    const viaTool = parentToolUseId === null ? undefined : this.taskByToolUse.get(parentToolUseId);
    return agentId ?? viaTool ?? this.sessionId;
  }

  /** The request record and agent usage for one model call, the first time it is seen. */
  private record(call: Omit<ApiRequest, 'sessionId' | 'timestamp'>): SessionEvent[] {
    if (this.recorded.has(call.messageId)) {
      return [];
    }
    this.recorded.add(call.messageId);
    const events: SessionEvent[] = [
      {
        name: 'request.recorded',
        payload: { ...call, sessionId: this.sessionId, timestamp: this.now() },
      },
    ];
    const agent = this.agents.get(call.agentId);
    if (agent !== undefined) {
      events.push(...this.agentEvent(call.agentId, { usage: addUsage(agent.usage, call.usage) }));
    }
    return events;
  }

  private message(event: MessageEvent): SessionEvent[] {
    const agentId = this.agentFor(event.agentId, event.parentToolUseId);
    const events: SessionEvent[] =
      event.usage === null
        ? []
        : this.record({
            messageId: event.messageId,
            requestId: event.requestId,
            agentId,
            model: event.model,
            usage: event.usage,
            costUsd: null,
            durationMs: null,
            ttftMs: null,
          });
    const items: FeedBody[] = [];
    for (const block of event.blocks) {
      switch (block.type) {
        case 'text': {
          items.push({ kind: 'text', text: block.text });
          break;
        }
        case 'thinking': {
          items.push({ kind: 'thinking', text: block.text });
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

  private usage(event: UsageEvent): SessionEvent[] {
    return this.record({
      messageId: event.messageId,
      requestId: event.requestId,
      agentId: this.agentFor(event.agentId, event.parentToolUseId),
      model: event.model,
      usage: event.usage,
      costUsd: event.costUsd,
      durationMs: event.durationMs,
      ttftMs: event.ttftMs,
    });
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

  private toolResult(result: ToolResultEvent): SessionEvent[] {
    const events: SessionEvent[] = [];
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
    return events;
  }

  private turnResult(event: TurnResultEvent): SessionEvent[] {
    this.turns += 1;
    const usage = event.usage ?? ZERO_USAGE;
    const state: SessionState = event.ok ? 'done' : 'failed';
    const events: SessionEvent[] = [
      this.summaryEvent({
        state,
        costUsd: event.costUsd ?? this.current.costUsd,
        usage: addUsage(this.current.usage, usage),
      }),
      ...this.agentEvent(this.sessionId, { state, currentTool: null }),
    ];
    if (!event.ok) {
      events.push(
        this.feed(this.sessionId, [
          { kind: 'system', text: `Turn failed (${event.subtype}): ${event.text ?? ''}` },
        ]),
      );
    }
    events.push({
      name: 'turn.result',
      payload: {
        ok: event.ok,
        subtype: event.subtype,
        text: event.text,
        costUsd: event.costUsd,
        turns: event.turns ?? this.turns,
        durationMs: event.durationMs,
        usage,
      },
    });
    return events;
  }

  private subagentStarted(event: SubagentStartedEvent): SessionEvent[] {
    const node = subagent(this.sessionId, event, this.now());
    this.agents.set(node.id, node);
    if (event.parentToolUseId !== null) {
      this.taskByToolUse.set(event.parentToolUseId, node.id);
    }
    return [
      { name: 'agent.upserted', payload: node },
      this.summaryEvent({ agentCount: this.agents.size - 1 }),
    ];
  }

  private subagentEnded(event: SubagentEndedEvent): SessionEvent[] {
    return this.agentEvent(event.agentId, {
      state: event.outcome === 'failed' ? 'failed' : 'done',
      endedAt: this.now(),
      currentTool: null,
    });
  }

  private compacted(event: CompactedEvent): SessionEvent[] {
    const at = this.now();
    const before = event.preTokens === null ? '' : `, ${String(event.preTokens)} tokens before`;
    return [
      {
        name: 'compaction.recorded',
        payload: { sessionId: this.sessionId, agentId: this.sessionId, at },
      },
      this.feed(this.sessionId, [
        { kind: 'system', text: `Context compacted (${event.trigger}${before})` },
      ]),
    ];
  }

  private rateLimit(event: RateLimitEvent): SessionEvent[] {
    const next = applyRateLimit(this.limits, event);
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
