// In-memory state built from EventBus events, and the view states the
// webviews need. Collections that grow with activity are bounded so a long
// running window does not leak.
// cspell:words sparkline

import type {
  AgentNode,
  ApiRequest,
  ContextSnapshot,
  FeedItem,
  PermissionRequest,
  SessionSummary,
  ToolCall,
} from '../../shared/model.js';
import type {
  AgentDetailState,
  ContextState,
  FleetState,
  RateLimits,
} from '../../shared/protocol.js';
import type { EventBus } from '../bus.js';

import { isTelemetry, mergeAgent, mergeCall, requestKey } from './merge.js';
import type { CallRecord } from './merge.js';
import { BoundedMap, RingBuffer } from './ring.js';
import { SessionScoped } from './scoped.js';
import { SparklineTracker } from './sparkline.js';
import type { SessionSparkline } from './sparkline.js';

/** Runs a callback after a delay and returns a function that cancels it. */
export type Scheduler = (callback: () => void, delayMs: number) => () => void;

export interface StoreLimits {
  /** Tool calls kept across all sessions. */
  readonly toolCalls: number;
  /** API requests kept across all sessions. */
  readonly requests: number;
  readonly feedPerAgent: number;
  readonly compactionsPerAgent: number;
}

export interface StoreOptions {
  readonly scheduler?: Scheduler | undefined;
  /** How long change notifications are held so bursts become one update. Defaults to 250. */
  readonly notifyDelayMs?: number | undefined;
  readonly limits?: Partial<StoreLimits> | undefined;
  /** For sparkline pruning. Defaults to Date.now. */
  readonly clock?: (() => number) | undefined;
  readonly sparklineMinutes?: number | undefined;
}

export const DEFAULT_LIMITS: StoreLimits = {
  toolCalls: 10_000,
  requests: 10_000,
  feedPerAgent: 500,
  compactionsPerAgent: 100,
};

export const DEFAULT_NOTIFY_DELAY_MS = 250;

const HOUR_MS = 3_600_000;

const NO_RATE_LIMITS: RateLimits = { fiveHourPct: null, sevenDayPct: null, resetsAt: null };

export const defaultScheduler: Scheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

function toolKey(call: Pick<ToolCall, 'sessionId' | 'id'>): string {
  return JSON.stringify([call.sessionId, call.id]);
}

function byStart(left: AgentNode, right: AgentNode): number {
  return left.startedAt - right.startedAt;
}

/** Every agent below one agent in its session, at any depth. */
function descendants(inSession: readonly AgentNode[], agentId: string): AgentNode[] {
  const found: AgentNode[] = [];
  const seen = new Set([agentId]);
  const queue = [agentId];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const node of inSession) {
      if (node.parentAgentId === parent && !seen.has(node.id)) {
        seen.add(node.id);
        found.push(node);
        queue.push(node.id);
      }
    }
  }
  return found;
}

interface ThreadActivity {
  readonly toolCalls: ToolCall[];
  readonly requests: ApiRequest[];
  readonly compactions: readonly number[];
}

export class OverlordStore {
  private readonly sessions = new Map<string, SessionSummary>();
  private readonly agents = new SessionScoped<AgentNode>();
  private readonly toolCalls: BoundedMap<string, ToolCall>;
  private readonly requests: BoundedMap<string, CallRecord>;
  /** Every message id and request id seen, to the key of the call it names. */
  private readonly requestAliases: BoundedMap<string, string>;
  private readonly feeds = new SessionScoped<RingBuffer<FeedItem>>();
  private readonly compactions = new SessionScoped<RingBuffer<number>>();
  private readonly snapshots = new SessionScoped<ContextSnapshot>();
  private readonly permissions = new Map<string, PermissionRequest>();
  private rateLimits: RateLimits = NO_RATE_LIMITS;
  private readonly sparklines: SparklineTracker;
  private readonly limits: StoreLimits;
  private readonly scheduler: Scheduler;
  private readonly notifyDelayMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions: (() => void)[];
  private cancelPending: (() => void) | null = null;

  constructor(bus: EventBus, options: StoreOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.toolCalls = new BoundedMap(this.limits.toolCalls);
    this.requests = new BoundedMap(this.limits.requests);
    this.requestAliases = new BoundedMap(this.limits.requests * 2);
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.notifyDelayMs = options.notifyDelayMs ?? DEFAULT_NOTIFY_DELAY_MS;
    this.sparklines = new SparklineTracker({
      minutes: options.sparklineMinutes,
      clock: options.clock,
    });
    this.subscriptions = this.subscribe(bus);
  }

  /** Called after a burst of changes settles. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions.length = 0;
    this.cancelPending?.();
    this.cancelPending = null;
  }

  fleetState(
    now: number,
  ): Omit<
    FleetState,
    | 'places'
    | 'activeSessionId'
    | 'activeVersion'
    | 'projects'
    | 'sessionProjects'
    | 'workspaceProjects'
    | 'health'
    | 'launched'
  > {
    return {
      sessions: [...this.sessions.values()].toSorted(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
      agents: this.agents.all().toSorted(byStart),
      pendingPermissions: [...this.permissions.values()].toSorted(
        (left, right) => left.requestedAt - right.requestedAt,
      ),
      rateLimits: this.rateLimits,
      spendPerHourUsd: this.spendSince(now - HOUR_MS, now),
    };
  }

  agentDetailState(sessionId: string, agentId: string): AgentDetailState {
    const agent = this.agents.get(sessionId, agentId) ?? null;
    const inSession = this.agents.inSession(sessionId);
    return {
      agent,
      session: this.sessions.get(sessionId) ?? null,
      children: inSession.filter((node) => node.parentAgentId === agentId).toSorted(byStart),
      failedAgents: descendants(inSession, agentId)
        .filter((node) => node.state === 'failed')
        .toSorted(byStart),
      failure: this.failureOf(agent),
      feed: this.feeds.get(sessionId, agentId)?.toArray() ?? [],
      ...this.agentActivity(sessionId, agentId),
    };
  }

  /**
   * Why a failed agent failed: what its transcript said, or else the error
   * result of the Agent call that started it. A background agent's call only
   * reports the launch, so that fallback has nothing for one.
   */
  private failureOf(agent: AgentNode | null): string | null {
    if (agent?.state !== 'failed') {
      return null;
    }
    if (agent.failure !== undefined) {
      return agent.failure;
    }
    if (agent.parentToolUseId === null) {
      return null;
    }
    const call = this.toolCalls.get(
      toolKey({ sessionId: agent.sessionId, id: agent.parentToolUseId }),
    );
    return call?.ok === false ? call.resultPreview : null;
  }

  /** One agent's tool calls, requests and compactions, each oldest first. */
  /** Every session's main thread tool calls, requests and compactions, gathered in one pass. */
  mainThreadActivity(): ReadonlyMap<
    string,
    Pick<AgentDetailState, 'toolCalls' | 'requests' | 'compactions'>
  > {
    const out = new Map<string, ThreadActivity>();
    const entry = (sessionId: string): ThreadActivity => {
      const found = out.get(sessionId);
      if (found !== undefined) {
        return found;
      }
      const made = {
        toolCalls: [],
        requests: [],
        compactions: this.compactions.get(sessionId, sessionId)?.toArray() ?? [],
      };
      out.set(sessionId, made);
      return made;
    };
    for (const call of this.toolCalls.values()) {
      if (call.agentId === call.sessionId) {
        entry(call.sessionId).toolCalls.push(call);
      }
    }
    for (const { merged: request } of this.requests.values()) {
      if (request.agentId === request.sessionId) {
        entry(request.sessionId).requests.push(request);
      }
    }
    return out;
  }

  agentActivity(
    sessionId: string,
    agentId: string,
  ): Pick<AgentDetailState, 'toolCalls' | 'requests' | 'compactions'> {
    const mine = (item: { readonly sessionId: string; readonly agentId: string }): boolean =>
      item.sessionId === sessionId && item.agentId === agentId;
    return {
      toolCalls: this.toolCalls
        .values()
        .filter((item) => mine(item))
        .toSorted((left, right) => left.startedAt - right.startedAt),
      requests: this.requests
        .values()
        .map((call) => call.merged)
        .filter((item) => mine(item))
        .toSorted((left, right) => left.timestamp - right.timestamp),
      compactions: (this.compactions.get(sessionId, agentId)?.toArray() ?? []).toSorted(
        (left, right) => left - right,
      ),
    };
  }

  /** A session and every subagent in it, oldest first, for the properties panel. */
  sessionProperties(sessionId: string): {
    readonly session: SessionSummary | null;
    readonly agents: readonly AgentNode[];
  } {
    return {
      session: this.sessions.get(sessionId) ?? null,
      agents: this.agents
        .inSession(sessionId)
        .filter((agent) => agent.parentAgentId !== null)
        .toSorted(byStart),
    };
  }

  /** The snapshot for one agent, the main thread when agentId is null. */
  contextState(sessionId: string, agentId: string | null = null): ContextState {
    return {
      snapshot: this.snapshots.get(sessionId, agentId ?? sessionId) ?? null,
      sessions: [...this.sessions.values()]
        .toSorted((left, right) => right.updatedAt - left.updatedAt)
        .map((session) => ({ id: session.id, title: session.title })),
    };
  }

  /** Sparkline series for every known session, keyed by session id. */
  sparklineState(now: number): Readonly<Record<string, SessionSparkline>> {
    const out: Record<string, SessionSparkline> = {};
    for (const id of this.sessions.keys()) {
      out[id] = this.sparklines.series(id, now);
    }
    return out;
  }

  private spendSince(start: number, end: number): number {
    let total = 0;
    for (const { merged: request } of this.requests.values()) {
      if (request.timestamp > start && request.timestamp <= end) {
        total += request.costUsd ?? 0;
      }
    }
    return total;
  }

  private changed(): void {
    if (this.cancelPending !== null) {
      return;
    }
    this.cancelPending = this.scheduler(() => {
      this.cancelPending = null;
      for (const listener of this.listeners) {
        listener();
      }
    }, this.notifyDelayMs);
  }

  private subscribe(bus: EventBus): (() => void)[] {
    return [
      bus.on('session.upserted', (session) => {
        this.sessions.set(session.id, session);
        this.changed();
      }),
      bus.on('session.removed', ({ sessionId }) => {
        this.removeSession(sessionId);
        this.changed();
      }),
      bus.on('agent.upserted', (agent) => {
        const known = this.agents.get(agent.sessionId, agent.id);
        this.agents.set(agent.sessionId, agent.id, mergeAgent(known, agent));
        this.changed();
      }),
      bus.on('tool.upserted', (call) => {
        this.recordToolCall(call);
        this.changed();
      }),
      bus.on('request.recorded', (request) => {
        this.recordRequest(request);
        this.changed();
      }),
      bus.on('feed.appended', ({ sessionId, agentId, items }) => {
        const feed = this.feeds.getOrCreate(
          sessionId,
          agentId,
          () => new RingBuffer<FeedItem>(this.limits.feedPerAgent),
        );
        for (const item of items) {
          feed.push(item);
        }
        this.changed();
      }),
      bus.on('context.updated', (snapshot) => {
        this.snapshots.set(snapshot.sessionId, snapshot.agentId, snapshot);
        this.changed();
      }),
      bus.on('compaction.recorded', ({ sessionId, agentId, at }) => {
        this.compactions
          .getOrCreate(
            sessionId,
            agentId,
            () => new RingBuffer<number>(this.limits.compactionsPerAgent),
          )
          .push(at);
        this.changed();
      }),
      bus.on('permission.requested', (request) => {
        this.permissions.set(request.id, request);
        this.changed();
      }),
      bus.on('permission.resolved', ({ requestId }) => {
        this.permissions.delete(requestId);
        this.changed();
      }),
      bus.on('rateLimits.updated', (limits) => {
        this.rateLimits = limits;
        this.changed();
      }),
    ];
  }

  private recordToolCall(call: ToolCall): void {
    const key = toolKey(call);
    if (this.toolCalls.get(key) === undefined) {
      this.sparklines.recordToolCall(call);
    }
    this.toolCalls.set(key, call);
  }

  /**
   * One API call shows up on several transcript lines and once more in
   * telemetry. The newest copy from each source wins, and the two sources
   * meet on the request id, which transcript lines carry beside the message
   * id. A copy that learns its request id late can join two calls into one.
   */
  private recordRequest(request: ApiRequest): void {
    const callId = request.requestId ?? request.messageId;
    const ids = [callId, request.messageId];
    const calls = this.callsNamed(request.sessionId, ids);
    const [first] = calls.keys();
    const callKey = first ?? requestKey(request.sessionId, callId);
    let message: ApiRequest | null = null;
    let telemetry: ApiRequest | null = null;
    for (const [key, call] of calls) {
      this.sparklines.forgetRequest(call.merged);
      if (key !== callKey) {
        this.requests.delete(key);
      }
      message ??= call.message;
      telemetry ??= call.telemetry;
    }
    if (isTelemetry(request)) {
      telemetry = request;
    } else {
      message = request;
    }
    const merged = mergeCall(message ?? request, telemetry ?? request);
    this.requests.set(callKey, { key: callKey, message, telemetry, merged });
    for (const id of ids) {
      this.requestAliases.set(requestKey(request.sessionId, id), callKey);
    }
    this.sparklines.recordRequest(merged);
  }

  /** The calls these ids already name, by call key. Two when a copy joins them. */
  private callsNamed(sessionId: string, ids: readonly string[]): Map<string, CallRecord> {
    const calls = new Map<string, CallRecord>();
    for (const id of ids) {
      const key = this.requestAliases.get(requestKey(sessionId, id));
      const call = key === undefined ? undefined : this.requests.get(key);
      if (call !== undefined) {
        calls.set(call.key, call);
      }
    }
    return calls;
  }

  /**
   * Drops what belongs to the session. Requests and tool calls stay (they are
   * bounded anyway) so the fleet spend rate still counts the last hour.
   */
  private removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.agents.deleteSession(sessionId);
    this.feeds.deleteSession(sessionId);
    this.compactions.deleteSession(sessionId);
    this.snapshots.deleteSession(sessionId);
    this.sparklines.removeSession(sessionId);
    for (const [id, request] of this.permissions) {
      if (request.sessionId === sessionId) {
        this.permissions.delete(id);
      }
    }
  }
}
