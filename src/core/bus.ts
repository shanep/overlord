// A small typed event bus. Sources publish, the store and views subscribe.

import type {
  AgentNode,
  ApiRequest,
  ContextSnapshot,
  FeedItem,
  PermissionRequest,
  SessionSummary,
  ToolCall,
} from '../shared/model.js';

export interface OverlordEvents {
  readonly 'session.upserted': SessionSummary;
  readonly 'session.removed': { readonly sessionId: string };
  readonly 'agent.upserted': AgentNode;
  readonly 'tool.upserted': ToolCall;
  readonly 'request.recorded': ApiRequest;
  readonly 'feed.appended': {
    readonly sessionId: string;
    readonly agentId: string;
    readonly items: readonly FeedItem[];
  };
  readonly 'context.updated': ContextSnapshot;
  readonly 'compaction.recorded': {
    readonly sessionId: string;
    readonly agentId: string;
    readonly at: number;
  };
  readonly 'permission.requested': PermissionRequest;
  readonly 'permission.resolved': { readonly requestId: string };
  readonly 'rateLimits.updated': {
    readonly fiveHourPct: number | null;
    readonly sevenDayPct: number | null;
    readonly resetsAt: number | null;
  };
  readonly 'source.error': { readonly source: string; readonly message: string };
}

export type EventName = keyof OverlordEvents;
export type Listener<K extends EventName> = (payload: OverlordEvents[K]) => void;

type ListenerSets = { readonly [K in EventName]: Set<Listener<K>> };

function createListenerSets(): ListenerSets {
  return {
    'session.upserted': new Set(),
    'session.removed': new Set(),
    'agent.upserted': new Set(),
    'tool.upserted': new Set(),
    'request.recorded': new Set(),
    'feed.appended': new Set(),
    'context.updated': new Set(),
    'compaction.recorded': new Set(),
    'permission.requested': new Set(),
    'permission.resolved': new Set(),
    'rateLimits.updated': new Set(),
    'source.error': new Set(),
  };
}

export class EventBus {
  private readonly listeners: ListenerSets = createListenerSets();

  on<K extends EventName>(name: K, listener: Listener<K>): () => void {
    const set = this.listeners[name];
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  emit<K extends EventName>(name: K, payload: OverlordEvents[K]): void {
    for (const listener of this.listeners[name]) {
      listener(payload);
    }
  }

  listenerCount(name: EventName): number {
    return this.listeners[name].size;
  }
}
