// cspell:words sparkline
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentNode,
  ApiRequest,
  ContextSnapshot,
  FeedItem,
  PermissionRequest,
  SessionSummary,
  ToolCall,
} from '../../shared/model.js';
import { ZERO_USAGE } from '../../shared/model.js';
import { EventBus } from '../bus.js';
import { toAgentNode } from '../hooks/mapping.js';
import { claudeEventOf } from '../hooks/test-helpers/claude-hook.js';

import {
  DEFAULT_LIMITS,
  DEFAULT_NOTIFY_DELAY_MS,
  defaultScheduler,
  OverlordStore,
} from './store.js';
import type { Scheduler, StoreOptions } from './store.js';

const HOUR = 3_600_000;
const NOW = 1_000_000_000_000;

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agent: 'claude-code',
    surface: 'cli',
    title: `title ${id}`,
    cwd: '/work',
    state: 'running',
    startedAt: NOW - HOUR,
    updatedAt: NOW,
    usage: ZERO_USAGE,
    costUsd: null,
    model: null,
    effort: null,
    permissionMode: null,
    pid: null,
    transcriptPath: null,
    gitBranch: null,
    version: null,
    agentCount: 0,
    contextFill: null,
    recap: null,
    lastPrompt: null,
    lastPromptAt: null,
    ...overrides,
  };
}

function agent(sessionId: string, id: string, overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    id,
    sessionId,
    parentAgentId: id === sessionId ? null : sessionId,
    parentToolUseId: null,
    agentType: 'general-purpose',
    description: '',
    spawnDepth: 0,
    background: false,
    state: 'running',
    startedAt: NOW,
    endedAt: null,
    transcriptPath: null,
    usage: ZERO_USAGE,
    toolCallCount: 0,
    currentTool: null,
    model: null,
    ...overrides,
  };
}

function request(messageId: string, overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    messageId,
    requestId: null,
    sessionId: 's1',
    agentId: 's1',
    model: 'claude-opus-5-5',
    timestamp: NOW,
    usage: { ...ZERO_USAGE, input: 10 },
    ttftMs: null,
    durationMs: null,
    costUsd: 1,
    ...overrides,
  };
}

function tool(id: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    sessionId: 's1',
    agentId: 's1',
    name: 'Read',
    input: {},
    startedAt: NOW,
    endedAt: null,
    ok: null,
    resultPreview: null,
    ...overrides,
  };
}

function permission(id: string, overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id,
    agent: 'claude-code',
    sessionId: 's1',
    agentId: 's1',
    toolName: 'Bash',
    input: {},
    requestedAt: NOW,
    source: 'hook',
    ...overrides,
  };
}

function snapshot(sessionId: string, agentId: string): ContextSnapshot {
  return {
    sessionId,
    agentId,
    at: NOW,
    systemPrompt: null,
    model: null,
    loaded: [],
    skipped: [],
    skills: [],
    agentTypes: [],
    mcpServers: [],
    deferredTools: [],
    environment: {},
    weights: [],
  };
}

function text(id: string): FeedItem {
  return { kind: 'text', id, at: NOW, text: id };
}

interface Pending {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

function setup(options: StoreOptions = {}): {
  bus: EventBus;
  store: OverlordStore;
  pending: Pending[];
  flush: () => void;
} {
  const pending: Pending[] = [];
  const scheduler: Scheduler = (callback, delayMs) => {
    const entry: Pending = { callback, delayMs, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const bus = new EventBus();
  const store = new OverlordStore(bus, { scheduler, clock: (): number => NOW, ...options });
  const flush = (): void => {
    const due = pending.splice(0);
    for (const entry of due) {
      if (!entry.cancelled) {
        entry.callback();
      }
    }
  };
  return { bus, store, pending, flush };
}

describe('OverlordStore fleetState', () => {
  it('starts empty', () => {
    const { store } = setup();
    expect(store.fleetState(NOW)).toStrictEqual({
      sessions: [],
      agents: [],
      pendingPermissions: [],
      rateLimits: { fiveHourPct: null, sevenDayPct: null, resetsAt: null },
      spendPerHourUsd: 0,
    });
  });

  it('lists sessions newest update first and replaces a session on upsert', () => {
    const { bus, store } = setup();
    bus.emit('session.upserted', session('a', { updatedAt: 1 }));
    bus.emit('session.upserted', session('b', { updatedAt: 3 }));
    bus.emit('session.upserted', session('c', { updatedAt: 2 }));
    expect(store.fleetState(NOW).sessions.map((item) => item.id)).toStrictEqual(['b', 'c', 'a']);
    bus.emit('session.upserted', session('a', { updatedAt: 4, title: 'new' }));
    const sessions = store.fleetState(NOW).sessions;
    expect(sessions.map((item) => item.id)).toStrictEqual(['a', 'b', 'c']);
    expect(sessions[0]?.title).toBe('new');
  });

  it('lists agents from every session by start time', () => {
    const { bus, store } = setup();
    bus.emit('agent.upserted', agent('s1', 'x', { startedAt: 3 }));
    bus.emit('agent.upserted', agent('s2', 'y', { startedAt: 1 }));
    bus.emit('agent.upserted', agent('s1', 'z', { startedAt: 2 }));
    expect(store.fleetState(NOW).agents.map((item) => item.id)).toStrictEqual(['y', 'z', 'x']);
  });

  it('keeps pending permissions oldest first until resolved', () => {
    const { bus, store } = setup();
    bus.emit('permission.requested', permission('p1', { requestedAt: 5 }));
    bus.emit('permission.requested', permission('p2', { requestedAt: 1 }));
    bus.emit('permission.requested', permission('p3', { requestedAt: 3 }));
    expect(store.fleetState(NOW).pendingPermissions.map((item) => item.id)).toStrictEqual([
      'p2',
      'p3',
      'p1',
    ]);
    bus.emit('permission.resolved', { requestId: 'p3' });
    bus.emit('permission.resolved', { requestId: 'unknown' });
    expect(store.fleetState(NOW).pendingPermissions.map((item) => item.id)).toStrictEqual([
      'p2',
      'p1',
    ]);
  });

  it('reports the latest rate limits', () => {
    const { bus, store } = setup();
    const limits = { fiveHourPct: 40, sevenDayPct: 10, resetsAt: NOW + HOUR };
    bus.emit('rateLimits.updated', limits);
    expect(store.fleetState(NOW).rateLimits).toStrictEqual(limits);
  });

  it('keeps windows and fields that a later report does not know', () => {
    const { bus, store } = setup();
    const codex = {
      agent: 'codex',
      id: 'primary',
      label: '5 hour',
      usedPct: 30,
      resetsAt: null,
    };
    const claude = { ...codex, agent: 'claude-code', id: 'five_hour', usedPct: 40 };
    bus.emit('rateLimits.updated', {
      fiveHourPct: 40,
      sevenDayPct: null,
      resetsAt: NOW,
      windows: [claude],
    });
    bus.emit('rateLimits.updated', {
      fiveHourPct: null,
      sevenDayPct: null,
      resetsAt: null,
      windows: [codex],
    });
    bus.emit('rateLimits.updated', {
      fiveHourPct: 45,
      sevenDayPct: 5,
      resetsAt: NOW,
      windows: [{ ...claude, usedPct: 45 }],
    });
    expect(store.rateLimitsState()).toStrictEqual({
      fiveHourPct: 45,
      sevenDayPct: 5,
      resetsAt: NOW,
      windows: [{ ...claude, usedPct: 45 }, codex],
    });
  });

  it('sums request cost over the last hour, inclusive of now only', () => {
    const { bus, store } = setup();
    bus.emit('request.recorded', request('old', { timestamp: NOW - HOUR, costUsd: 100 }));
    bus.emit('request.recorded', request('edge', { timestamp: NOW - HOUR + 1, costUsd: 1 }));
    bus.emit('request.recorded', request('now', { timestamp: NOW, costUsd: 2 }));
    bus.emit('request.recorded', request('free', { timestamp: NOW, costUsd: null }));
    bus.emit('request.recorded', request('future', { timestamp: NOW + 1, costUsd: 50 }));
    bus.emit('request.recorded', request('other', { sessionId: 's2', costUsd: 4 }));
    expect(store.fleetState(NOW).spendPerHourUsd).toBe(7);
  });

  it('counts a repeated message once, with its newest cost', () => {
    const { bus, store } = setup();
    bus.emit('request.recorded', request('m', { costUsd: 1 }));
    bus.emit('request.recorded', request('m', { costUsd: 3 }));
    expect(store.fleetState(NOW).spendPerHourUsd).toBe(3);
    expect(store.agentDetailState('s1', 's1').requests).toStrictEqual([
      request('m', { costUsd: 3 }),
    ]);
  });
});

describe('OverlordStore requests from the transcript and telemetry', () => {
  // The transcript names a call by its message id and also carries the
  // request id. Telemetry only knows the request id and puts it in messageId.
  const fromTranscript = request('msg_01A', {
    requestId: 'req_01A',
    agentId: 'sub',
    timestamp: NOW - 1000,
    usage: { input: 100, output: 40, cacheRead: 2000, cacheCreation: 0, thinking: 12 },
    costUsd: 5,
  });
  const fromTelemetry = request('req_01A', {
    requestId: 'req_01A',
    usage: { input: 100, output: 42, cacheRead: 2000, cacheCreation: 0, thinking: 0 },
    ttftMs: 350,
    durationMs: 900,
    costUsd: 6,
  });
  const merged = request('msg_01A', {
    requestId: 'req_01A',
    agentId: 'sub',
    timestamp: NOW - 1000,
    usage: { input: 100, output: 42, cacheRead: 2000, cacheCreation: 0, thinking: 12 },
    ttftMs: 350,
    durationMs: 900,
    costUsd: 6,
  });

  it('counts one call once when the transcript reports it first', () => {
    const { bus, store } = setup();
    bus.emit('request.recorded', fromTranscript);
    bus.emit('request.recorded', fromTelemetry);
    expect(store.fleetState(NOW).spendPerHourUsd).toBe(6);
    expect(store.agentDetailState('s1', 'sub').requests).toStrictEqual([merged]);
    expect(store.agentDetailState('s1', 's1').requests).toStrictEqual([]);
  });

  it('counts one call once when telemetry reports it first', () => {
    const { bus, store } = setup();
    bus.emit('request.recorded', fromTelemetry);
    bus.emit('request.recorded', fromTranscript);
    expect(store.fleetState(NOW).spendPerHourUsd).toBe(6);
    expect(store.agentDetailState('s1', 'sub').requests).toStrictEqual([merged]);
  });

  it('keeps telemetry timings and cost when a newer transcript copy arrives', () => {
    const { bus, store } = setup({ sparklineMinutes: 1 });
    bus.emit('session.upserted', session('s1'));
    bus.emit('request.recorded', fromTranscript);
    bus.emit('request.recorded', fromTelemetry);
    bus.emit('request.recorded', {
      ...fromTranscript,
      usage: { ...fromTranscript.usage, output: 50 },
    });
    const usage = { ...merged.usage, output: 50 };
    expect(store.agentDetailState('s1', 'sub').requests).toStrictEqual([{ ...merged, usage }]);
    expect(store.sparklineState(NOW)).toStrictEqual({
      s1: { tokensPerMinute: [2150], toolCallsPerMinute: [0], costPerMinute: [6] },
    });
  });

  it('joins a copy that learns its request id after telemetry reported the call', () => {
    const { bus, store } = setup();
    bus.emit('request.recorded', { ...fromTranscript, requestId: null });
    bus.emit('request.recorded', fromTelemetry);
    bus.emit('request.recorded', fromTranscript);
    expect(store.fleetState(NOW).spendPerHourUsd).toBe(6);
    expect(store.agentDetailState('s1', 'sub').requests).toStrictEqual([merged]);
  });

  it('treats the same message id in two sessions as two calls', () => {
    const { bus, store } = setup();
    bus.emit('request.recorded', request('m', { costUsd: 1 }));
    bus.emit('request.recorded', request('m', { sessionId: 's2', agentId: 's2', costUsd: 2 }));
    expect(store.fleetState(NOW).spendPerHourUsd).toBe(3);
  });
});

describe('OverlordStore agents reported by the transcript and hooks', () => {
  const usage = { input: 900, output: 300, cacheRead: 40_000, cacheCreation: 1200, thinking: 50 };
  // A nested subagent as the transcript tailer sees it: it knows the spawning
  // tool use, the real parent, the depth, the usage and the model.
  const fromTranscript = agent('s1', 'a2', {
    parentAgentId: 'a1',
    parentToolUseId: 'toolu_01',
    agentType: 'Explore',
    description: 'Find the event bus',
    spawnDepth: 2,
    background: true,
    startedAt: NOW - 5000,
    transcriptPath: '/t/s1/subagents/agent-a2.jsonl',
    usage,
    toolCallCount: 7,
    currentTool: 'Grep',
    model: 'claude-haiku-4-5',
  });
  const start = claudeEventOf('subagent-start', {
    session_id: 's1',
    hook_event_name: 'SubagentStart',
    agent_id: 'a2',
    agent_type: 'Explore',
  });
  const stop = claudeEventOf('subagent-stop', {
    session_id: 's1',
    hook_event_name: 'SubagentStop',
    agent_id: 'a2',
    agent_type: 'Explore',
  });

  it('keeps what the transcript knows when a SubagentStop hook node arrives later', () => {
    const { bus, store } = setup();
    bus.emit('agent.upserted', fromTranscript);
    bus.emit('agent.upserted', toAgentNode(stop, { startedAt: NOW - 4000, endedAt: NOW }));
    expect(store.agentDetailState('s1', 'a2').agent).toStrictEqual({
      ...fromTranscript,
      state: 'done',
      endedAt: NOW,
      currentTool: null,
    });
  });

  it('lets the transcript fill in a node a SubagentStart hook made first', () => {
    const { bus, store } = setup();
    bus.emit('agent.upserted', toAgentNode(start, { startedAt: NOW - 4000, endedAt: null }));
    bus.emit('agent.upserted', fromTranscript);
    expect(store.agentDetailState('s1', 'a2').agent).toStrictEqual(fromTranscript);
  });

  it('still applies real updates after a hook node', () => {
    const { bus, store } = setup();
    bus.emit('agent.upserted', fromTranscript);
    bus.emit('agent.upserted', toAgentNode(stop, { startedAt: NOW - 4000, endedAt: NOW }));
    bus.emit('agent.upserted', toAgentNode(start, { startedAt: NOW - 4000, endedAt: null }));
    const more = { ...usage, output: 500 };
    bus.emit('agent.upserted', { ...fromTranscript, usage: more, toolCallCount: 9 });
    expect(store.agentDetailState('s1', 'a2').agent).toStrictEqual({
      ...fromTranscript,
      usage: more,
      toolCallCount: 9,
    });
  });

  it('moves an agent when the transcript learns its real parent', () => {
    const { bus, store } = setup();
    const early = { ...fromTranscript, parentAgentId: 's1', spawnDepth: 1 };
    bus.emit('agent.upserted', early);
    bus.emit('agent.upserted', fromTranscript);
    expect(store.agentDetailState('s1', 'a2').agent).toStrictEqual(fromTranscript);
  });
});

describe('OverlordStore sessionProperties', () => {
  it('is empty for an unknown session', () => {
    const { store } = setup();
    expect(store.sessionProperties('s')).toStrictEqual({ session: null, agents: [] });
  });

  it('lists every subagent in the session, all depths, oldest first', () => {
    const { bus, store } = setup();
    bus.emit('session.upserted', session('s1'));
    bus.emit('agent.upserted', agent('s1', 's1'));
    bus.emit('agent.upserted', agent('s1', 'late', { startedAt: 9 }));
    bus.emit('agent.upserted', agent('s1', 'early', { startedAt: 1 }));
    bus.emit('agent.upserted', agent('s1', 'grandchild', { parentAgentId: 'early', startedAt: 5 }));
    bus.emit('agent.upserted', agent('s2', 'elsewhere', { parentAgentId: 's2' }));
    const properties = store.sessionProperties('s1');
    expect(properties.session).toStrictEqual(session('s1'));
    expect(properties.agents.map((item) => item.id)).toStrictEqual(['early', 'grandchild', 'late']);
  });
});

describe('OverlordStore agentDetailState', () => {
  it('is empty for an unknown agent', () => {
    const { store } = setup();
    expect(store.agentDetailState('s', 'a')).toStrictEqual({
      agent: null,
      session: null,
      children: [],
      failedAgents: [],
      failure: null,
      feed: [],
      toolCalls: [],
      requests: [],
      compactions: [],
    });
  });

  it('gathers the agent, its session and its direct children', () => {
    const { bus, store } = setup();
    bus.emit('session.upserted', session('s1'));
    bus.emit('agent.upserted', agent('s1', 's1'));
    bus.emit('agent.upserted', agent('s1', 'late', { startedAt: 9 }));
    bus.emit('agent.upserted', agent('s1', 'early', { startedAt: 1 }));
    bus.emit('agent.upserted', agent('s1', 'grandchild', { parentAgentId: 'early' }));
    bus.emit('agent.upserted', agent('s2', 'elsewhere', { parentAgentId: 's1' }));
    const detail = store.agentDetailState('s1', 's1');
    expect(detail.agent).toStrictEqual(agent('s1', 's1'));
    expect(detail.session).toStrictEqual(session('s1'));
    expect(detail.children.map((item) => item.id)).toStrictEqual(['early', 'late']);
    expect(store.agentDetailState('s1', 'early').children.map((item) => item.id)).toStrictEqual([
      'grandchild',
    ]);
  });

  it('keeps tool calls and requests for this agent only, in time order', () => {
    const { bus, store } = setup();
    bus.emit('tool.upserted', tool('t2', { startedAt: 2 }));
    bus.emit('tool.upserted', tool('t1', { startedAt: 1 }));
    bus.emit('tool.upserted', tool('t3', { agentId: 'sub' }));
    bus.emit('tool.upserted', tool('t4', { sessionId: 's2' }));
    bus.emit('request.recorded', request('r2', { timestamp: 2 }));
    bus.emit('request.recorded', request('r1', { timestamp: 1 }));
    bus.emit('request.recorded', request('r3', { agentId: 'sub' }));
    bus.emit('request.recorded', request('r4', { sessionId: 's2' }));
    const detail = store.agentDetailState('s1', 's1');
    expect(detail.toolCalls.map((item) => item.id)).toStrictEqual(['t1', 't2']);
    expect(detail.requests.map((item) => item.messageId)).toStrictEqual(['r1', 'r2']);
  });

  it('updates a tool call in place', () => {
    const { bus, store } = setup();
    bus.emit('tool.upserted', tool('t1'));
    bus.emit('tool.upserted', tool('t1', { ok: true, endedAt: NOW + 5 }));
    expect(store.agentDetailState('s1', 's1').toolCalls).toStrictEqual([
      tool('t1', { ok: true, endedAt: NOW + 5 }),
    ]);
  });

  it('treats the same tool id in two sessions as two calls', () => {
    const { bus, store } = setup();
    bus.emit('tool.upserted', tool('t1'));
    bus.emit('tool.upserted', tool('t1', { sessionId: 's2', agentId: 's2' }));
    expect(store.agentDetailState('s1', 's1').toolCalls).toHaveLength(1);
    expect(store.agentDetailState('s2', 's2').toolCalls).toHaveLength(1);
  });

  it('lists failed agents at any depth below an agent, oldest first', () => {
    const { bus, store } = setup();
    bus.emit('agent.upserted', agent('s1', 's1'));
    bus.emit('agent.upserted', agent('s1', 'ok', { state: 'done' }));
    bus.emit('agent.upserted', agent('s1', 'late', { state: 'failed', startedAt: NOW + 2 }));
    bus.emit('agent.upserted', agent('s1', 'deep', { parentAgentId: 'ok', state: 'failed' }));
    bus.emit('agent.upserted', agent('s2', 'other', { state: 'failed' }));
    expect(store.agentDetailState('s1', 's1').failedAgents.map((node) => node.id)).toStrictEqual([
      'deep',
      'late',
    ]);
    expect(store.agentDetailState('s1', 'ok').failedAgents.map((node) => node.id)).toStrictEqual([
      'deep',
    ]);
  });

  it('takes the error of a failed agent from the Agent call that started it', () => {
    const { bus, store } = setup();
    bus.emit('agent.upserted', agent('s1', 'sub', { state: 'failed', parentToolUseId: 't1' }));
    bus.emit('tool.upserted', tool('t1', { name: 'Agent', ok: false, resultPreview: 'API Error' }));
    expect(store.agentDetailState('s1', 'sub').failure).toBe('API Error');
    expect(store.agentDetailState('s1', 's1').failure).toBeNull();
  });

  it('prefers the failure the transcript gave the agent', () => {
    const { bus, store } = setup();
    const failed = agent('s1', 'sub', { state: 'failed', parentToolUseId: 't1' });
    bus.emit('agent.upserted', { ...failed, failure: 'Session limit' });
    bus.emit('tool.upserted', tool('t1', { name: 'Agent', ok: false, resultPreview: 'API Error' }));
    expect(store.agentDetailState('s1', 'sub').failure).toBe('Session limit');
    bus.emit('agent.upserted', failed);
    expect(store.agentDetailState('s1', 'sub').failure).toBe('Session limit');
  });

  it('has no error for a failed background agent, whose call only reports the launch', () => {
    const { bus, store } = setup();
    bus.emit('agent.upserted', agent('s1', 'sub', { state: 'failed', parentToolUseId: 't1' }));
    bus.emit('tool.upserted', tool('t1', { name: 'Agent', ok: true, resultPreview: 'Launched' }));
    expect(store.agentDetailState('s1', 'sub').failure).toBeNull();
  });

  it('appends feed items per agent and keeps the newest past the limit', () => {
    const { bus, store } = setup({ limits: { feedPerAgent: 2 } });
    bus.emit('feed.appended', { sessionId: 's1', agentId: 's1', items: [text('a'), text('b')] });
    bus.emit('feed.appended', { sessionId: 's1', agentId: 's1', items: [text('c')] });
    bus.emit('feed.appended', { sessionId: 's1', agentId: 'sub', items: [text('d')] });
    expect(store.agentDetailState('s1', 's1').feed).toStrictEqual([text('b'), text('c')]);
    expect(store.agentDetailState('s1', 'sub').feed).toStrictEqual([text('d')]);
  });

  it('keeps compaction times sorted and bounded', () => {
    const { bus, store } = setup({ limits: { compactionsPerAgent: 2 } });
    bus.emit('compaction.recorded', { sessionId: 's1', agentId: 's1', at: 30 });
    bus.emit('compaction.recorded', { sessionId: 's1', agentId: 's1', at: 10 });
    expect(store.agentDetailState('s1', 's1').compactions).toStrictEqual([10, 30]);
    bus.emit('compaction.recorded', { sessionId: 's1', agentId: 's1', at: 20 });
    expect(store.agentDetailState('s1', 's1').compactions).toStrictEqual([10, 20]);
  });

  it('bounds tool calls and requests across sessions', () => {
    const { bus, store } = setup({ limits: { toolCalls: 2, requests: 2 } });
    for (const id of ['1', '2', '3']) {
      bus.emit('tool.upserted', tool(`t${id}`, { startedAt: Number(id) }));
      bus.emit('request.recorded', request(`r${id}`, { timestamp: Number(id) }));
    }
    const detail = store.agentDetailState('s1', 's1');
    expect(detail.toolCalls.map((item) => item.id)).toStrictEqual(['t2', 't3']);
    expect(detail.requests.map((item) => item.messageId)).toStrictEqual(['r2', 'r3']);
  });

  it('uses generous default limits', () => {
    expect(DEFAULT_LIMITS).toStrictEqual({
      toolCalls: 10_000,
      requests: 10_000,
      feedPerAgent: 500,
      compactionsPerAgent: 100,
    });
    const { bus, store } = setup();
    for (let index = 0; index < 501; index += 1) {
      bus.emit('feed.appended', { sessionId: 's1', agentId: 's1', items: [text(String(index))] });
    }
    const feed = store.agentDetailState('s1', 's1').feed;
    expect(feed).toHaveLength(500);
    expect(feed[0]).toStrictEqual(text('1'));
    for (let index = 0; index < 101; index += 1) {
      bus.emit('compaction.recorded', { sessionId: 's1', agentId: 's1', at: index });
    }
    expect(store.agentDetailState('s1', 's1').compactions).toHaveLength(100);
  });
});

describe('OverlordStore contextState', () => {
  it('returns the main thread snapshot by default and a subagent snapshot on request', () => {
    const { bus, store } = setup();
    bus.emit('session.upserted', session('s1', { updatedAt: 1 }));
    bus.emit('session.upserted', session('s2', { updatedAt: 2 }));
    bus.emit('context.updated', snapshot('s1', 's1'));
    bus.emit('context.updated', snapshot('s1', 'sub'));
    expect(store.contextState('s1')).toStrictEqual({
      snapshot: snapshot('s1', 's1'),
      sessions: [
        { id: 's2', title: 'title s2' },
        { id: 's1', title: 'title s1' },
      ],
    });
    expect(store.contextState('s1', null).snapshot).toStrictEqual(snapshot('s1', 's1'));
    expect(store.contextState('s1', 'sub').snapshot).toStrictEqual(snapshot('s1', 'sub'));
    expect(store.contextState('s2').snapshot).toBeNull();
  });
});

describe('OverlordStore sparklineState', () => {
  it('has a series per known session, counting each tool and message once', () => {
    const { bus, store } = setup({ sparklineMinutes: 2 });
    bus.emit('session.upserted', session('s1'));
    bus.emit('tool.upserted', tool('t1'));
    bus.emit('tool.upserted', tool('t1', { ok: true }));
    bus.emit('tool.upserted', tool('t1', { ok: false }));
    bus.emit('request.recorded', request('m', { usage: { ...ZERO_USAGE, input: 5 }, costUsd: 1 }));
    bus.emit('request.recorded', request('m', { usage: { ...ZERO_USAGE, input: 7 }, costUsd: 2 }));
    bus.emit('tool.upserted', tool('t9', { sessionId: 'unknown' }));
    expect(store.sparklineState(NOW)).toStrictEqual({
      s1: { tokensPerMinute: [0, 7], toolCallsPerMinute: [0, 1], costPerMinute: [0, 2] },
    });
  });
});

describe('OverlordStore session removal', () => {
  it('drops everything scoped to the session but keeps spend history', () => {
    const { bus, store } = setup();
    bus.emit('session.upserted', session('s1'));
    bus.emit('session.upserted', session('s2'));
    bus.emit('agent.upserted', agent('s1', 's1'));
    bus.emit('feed.appended', { sessionId: 's1', agentId: 's1', items: [text('a')] });
    bus.emit('compaction.recorded', { sessionId: 's1', agentId: 's1', at: 1 });
    bus.emit('context.updated', snapshot('s1', 's1'));
    bus.emit('permission.requested', permission('p1'));
    bus.emit('permission.requested', permission('p2', { sessionId: 's2' }));
    bus.emit('request.recorded', request('m', { costUsd: 2 }));
    bus.emit('tool.upserted', tool('t1'));
    bus.emit('session.removed', { sessionId: 's1' });
    const fleet = store.fleetState(NOW);
    expect(fleet.sessions.map((item) => item.id)).toStrictEqual(['s2']);
    expect(fleet.agents).toStrictEqual([]);
    expect(fleet.pendingPermissions.map((item) => item.id)).toStrictEqual(['p2']);
    expect(fleet.spendPerHourUsd).toBe(2);
    const detail = store.agentDetailState('s1', 's1');
    expect(detail.feed).toStrictEqual([]);
    expect(detail.compactions).toStrictEqual([]);
    expect(detail.toolCalls).toHaveLength(1);
    expect(store.contextState('s1').snapshot).toBeNull();
    expect(Object.keys(store.sparklineState(NOW))).toStrictEqual(['s2']);
  });

  it('starts a fresh sparkline if the session comes back', () => {
    const { bus, store } = setup({ sparklineMinutes: 1 });
    bus.emit('session.upserted', session('s1'));
    bus.emit('tool.upserted', tool('t1'));
    bus.emit('session.removed', { sessionId: 's1' });
    bus.emit('session.upserted', session('s1'));
    expect(store.sparklineState(NOW)['s1']?.toolCallsPerMinute).toStrictEqual([0]);
  });
});

describe('OverlordStore change notifications', () => {
  it('coalesces a burst of events into one notification', () => {
    const { bus, store, pending, flush } = setup();
    const listener = vi.fn();
    store.onChange(listener);
    bus.emit('session.upserted', session('s1'));
    bus.emit('agent.upserted', agent('s1', 's1'));
    bus.emit('rateLimits.updated', { fiveHourPct: 1, sevenDayPct: 1, resetsAt: null });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.delayMs).toBe(DEFAULT_NOTIFY_DELAY_MS);
    expect(listener).not.toHaveBeenCalled();
    flush();
    expect(listener).toHaveBeenCalledTimes(1);
    bus.emit('session.removed', { sessionId: 's1' });
    expect(pending).toHaveLength(1);
    flush();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('uses the configured delay', () => {
    const { bus, pending } = setup({ notifyDelayMs: 1000 });
    bus.emit('permission.resolved', { requestId: 'x' });
    expect(pending.map((entry) => entry.delayMs)).toStrictEqual([1000]);
    expect(DEFAULT_NOTIFY_DELAY_MS).toBe(250);
  });

  it.each([
    [
      'session.upserted',
      (bus: EventBus): void => {
        bus.emit('session.upserted', session('s'));
      },
    ],
    [
      'session.removed',
      (bus: EventBus): void => {
        bus.emit('session.removed', { sessionId: 's' });
      },
    ],
    [
      'agent.upserted',
      (bus: EventBus): void => {
        bus.emit('agent.upserted', agent('s', 'a'));
      },
    ],
    [
      'tool.upserted',
      (bus: EventBus): void => {
        bus.emit('tool.upserted', tool('t'));
      },
    ],
    [
      'request.recorded',
      (bus: EventBus): void => {
        bus.emit('request.recorded', request('m'));
      },
    ],
    [
      'feed.appended',
      (bus: EventBus): void => {
        bus.emit('feed.appended', { sessionId: 's', agentId: 'a', items: [] });
      },
    ],
    [
      'context.updated',
      (bus: EventBus): void => {
        bus.emit('context.updated', snapshot('s', 's'));
      },
    ],
    [
      'compaction.recorded',
      (bus: EventBus): void => {
        bus.emit('compaction.recorded', { sessionId: 's', agentId: 'a', at: 1 });
      },
    ],
    [
      'permission.requested',
      (bus: EventBus): void => {
        bus.emit('permission.requested', permission('p'));
      },
    ],
    [
      'permission.resolved',
      (bus: EventBus): void => {
        bus.emit('permission.resolved', { requestId: 'p' });
      },
    ],
    [
      'rateLimits.updated',
      (bus: EventBus): void => {
        bus.emit('rateLimits.updated', { fiveHourPct: null, sevenDayPct: null, resetsAt: null });
      },
    ],
  ])('notifies after %s', (_name, emit) => {
    const { bus, store, flush } = setup();
    const listener = vi.fn();
    store.onChange(listener);
    emit(bus);
    flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores source errors', () => {
    const { bus, pending } = setup();
    bus.emit('source.error', { source: 'x', message: 'y' });
    expect(pending).toHaveLength(0);
  });

  it('stops notifying a listener that unsubscribed', () => {
    const { bus, store, flush } = setup();
    const kept = vi.fn();
    const dropped = vi.fn();
    store.onChange(kept);
    const off = store.onChange(dropped);
    off();
    bus.emit('session.upserted', session('s1'));
    flush();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('cancels pending work and detaches from the bus on dispose', () => {
    const { bus, store, pending, flush } = setup();
    const listener = vi.fn();
    store.onChange(listener);
    expect(bus.listenerCount('session.upserted')).toBe(1);
    bus.emit('session.upserted', session('s1'));
    store.dispose();
    expect(pending[0]?.cancelled).toBe(true);
    flush();
    expect(listener).not.toHaveBeenCalled();
    expect(bus.listenerCount('session.upserted')).toBe(0);
    expect(bus.listenerCount('rateLimits.updated')).toBe(0);
    bus.emit('session.upserted', session('s2'));
    expect(pending).toHaveLength(0);
    expect(store.fleetState(NOW).sessions.map((item) => item.id)).toStrictEqual(['s1']);
    store.dispose();
  });
});

describe('defaultScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the callback after the delay', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    defaultScheduler(callback, 100);
    vi.advanceTimersByTime(99);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const cancel = defaultScheduler(callback, 100);
    cancel();
    vi.advanceTimersByTime(200);
    expect(callback).not.toHaveBeenCalled();
  });

  it('is what the store uses when no scheduler is given', () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const store = new OverlordStore(bus);
    const listener = vi.fn();
    store.onChange(listener);
    bus.emit('session.upserted', session('s1'));
    vi.advanceTimersByTime(249);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    store.dispose();
  });
});
