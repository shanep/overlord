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

function toolKey(call: ToolCall): string {
  return JSON.stringify([call.sessionId, call.id]);
}

function byStart(left: AgentNode, right: AgentNode): number {
  return left.startedAt - right.startedAt;
}

export class OverlordStore {
  private readonly sessions = new Map<string, SessionSummary>();
  private readonly agents = new SessionScoped<AgentNode>();
  private readonly toolCalls: BoundedMap<string, ToolCall>;
  private readonly requests: BoundedMap<string, ApiRequest>;
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

  fleetState(now: number): FleetState {
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
    const mine = (item: { readonly sessionId: string; readonly agentId: string }): boolean =>
      item.sessionId === sessionId && item.agentId === agentId;
    return {
      agent: this.agents.get(sessionId, agentId) ?? null,
      session: this.sessions.get(sessionId) ?? null,
      children: this.agents
        .inSession(sessionId)
        .filter((agent) => agent.parentAgentId === agentId)
        .toSorted(byStart),
      feed: this.feeds.get(sessionId, agentId)?.toArray() ?? [],
      toolCalls: this.toolCalls
        .values()
        .filter((item) => mine(item))
        .toSorted((left, right) => left.startedAt - right.startedAt),
      requests: this.requests
        .values()
        .filter((item) => mine(item))
        .toSorted((left, right) => left.timestamp - right.timestamp),
      compactions: (this.compactions.get(sessionId, agentId)?.toArray() ?? []).toSorted(
        (left, right) => left - right,
      ),
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
    for (const request of this.requests.values()) {
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
        this.agents.set(agent.sessionId, agent.id, agent);
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

  /** One API call shows up on several transcript lines. The newest copy wins. */
  private recordRequest(request: ApiRequest): void {
    const previous = this.requests.get(request.messageId);
    if (previous !== undefined) {
      this.sparklines.forgetRequest(previous);
    }
    this.sparklines.recordRequest(request);
    this.requests.set(request.messageId, request);
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
