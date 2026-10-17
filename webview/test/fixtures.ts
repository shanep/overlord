// Synthetic but realistic view states for webview tests. Nothing here comes
// from a real machine.

import type {
  AgentNode,
  ApiRequest,
  FeedItem,
  PermissionRequest,
  SessionSummary,
  TokenUsage,
  ToolCall,
} from '../../src/shared/model.js';
import type { AgentDetailState, FleetState } from '../../src/shared/protocol.js';

export const NOW = Date.UTC(2026, 9, 15, 17, 0, 0);
const MINUTE = 60_000;

export function usage(input: number, output: number, cacheRead = 0, cacheCreation = 0): TokenUsage {
  return { input, output, cacheRead, cacheCreation, thinking: 0 };
}

export function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    agent: 'claude-code',
    surface: 'cli',
    title: `Session ${overrides.id}`,
    cwd: `/Users/dev/repos/${overrides.id}`,
    state: 'running',
    startedAt: NOW - 10 * MINUTE,
    updatedAt: NOW - MINUTE,
    usage: usage(12_000, 3400, 80_000, 6000),
    costUsd: 0.42,
    model: 'claude-opus-4-7',
    effort: 'high',
    permissionMode: 'default',
    pid: 4242,
    transcriptPath: null,
    gitBranch: 'main',
    version: '2.1.301',
    agentCount: 0,
    contextFill: 0.35,
    recap: null,
    lastPrompt: null,
    lastPromptAt: null,
    ...overrides,
  };
}

export function agent(
  overrides: Partial<AgentNode> & { id: string; sessionId: string },
): AgentNode {
  return {
    parentAgentId: null,
    parentToolUseId: null,
    agentType: 'main',
    description: 'Main thread',
    spawnDepth: 0,
    background: false,
    state: 'running',
    startedAt: NOW - 10 * MINUTE,
    endedAt: null,
    transcriptPath: null,
    usage: usage(12_000, 3400, 80_000, 6000),
    toolCallCount: 20,
    currentTool: null,
    model: 'claude-opus-4-7',
    ...overrides,
  };
}

export const permission: PermissionRequest = {
  id: 'perm-1',
  agent: 'claude-code',
  sessionId: 's1',
  agentId: 's1',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  requestedAt: NOW - 30_000,
  source: 'hook',
};

export const fleetState: FleetState = {
  sessions: [
    session({
      id: 's1',
      title: 'Refactor parser',
      agentCount: 2,
      costUsd: 1.25,
      contextFill: 0.82,
    }),
    session({
      id: 's2',
      title: 'Write docs',
      surface: 'desktop-code',
      state: 'waiting',
      startedAt: NOW - 40 * MINUTE,
      costUsd: 0.1,
      contextFill: 0.95,
      model: 'claude-sonnet-4-6',
      effort: null,
    }),
    session({
      id: 's3',
      title: 'Old run',
      surface: 'overlord',
      state: 'done',
      startedAt: NOW - 120 * MINUTE,
      costUsd: null,
      contextFill: null,
      usage: usage(0, 0),
      model: null,
    }),
  ],
  agents: [
    agent({ id: 's1', sessionId: 's1', toolCallCount: 30, currentTool: 'Edit' }),
    agent({
      id: 'a1',
      sessionId: 's1',
      parentAgentId: 's1',
      parentToolUseId: 'tu-1',
      agentType: 'Explore',
      description: 'Find parser tests',
      spawnDepth: 1,
      currentTool: 'Grep',
      toolCallCount: 12,
      startedAt: NOW - 5 * MINUTE,
    }),
    agent({
      id: 'a2',
      sessionId: 's1',
      parentAgentId: 'a1',
      agentType: 'general-purpose',
      description: 'Read fixtures',
      spawnDepth: 2,
      state: 'done',
      endedAt: NOW - MINUTE,
      toolCallCount: 4,
      startedAt: NOW - 4 * MINUTE,
    }),
    agent({ id: 's2', sessionId: 's2', toolCallCount: 3 }),
  ],
  pendingPermissions: [permission],
  places: { s1: 'vscode', s2: 'background' },
  projects: [],
  sessionProjects: {},
  workspaceProjects: [],
  launched: ['s3'],
  activeSessionId: null,
  activeVersion: 0,
  rateLimits: { fiveHourPct: 0.64, sevenDayPct: 0.2, resetsAt: NOW + 90 * MINUTE },
  spendPerHourUsd: 3.5,
  health: {},
};

const mainAgent = fleetState.agents[0];
const firstSession = fleetState.sessions[0];

function request(index: number, overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    messageId: `msg-${index.toString()}`,
    requestId: `req-${index.toString()}`,
    sessionId: 's1',
    agentId: 's1',
    model: 'claude-opus-4-7',
    timestamp: NOW - (10 - index) * MINUTE,
    usage: usage(1000 + index * 100, 400, 20_000 + index * 5000, 2000),
    ttftMs: 900,
    durationMs: 4000,
    costUsd: 0.05,
    ...overrides,
  };
}

export const requests: readonly ApiRequest[] = [
  request(1),
  request(2),
  request(3, { costUsd: null }),
  request(4, { usage: usage(0, 10) }),
];

function call(index: number, overrides: Partial<ToolCall> = {}): ToolCall {
  const startedAt = NOW - (10 - index) * MINUTE;
  return {
    id: `tu-${index.toString()}`,
    sessionId: 's1',
    agentId: 's1',
    name: 'Read',
    input: { file_path: `/src/file-${index.toString()}.ts` },
    startedAt,
    endedAt: startedAt + 2000,
    ok: true,
    resultPreview: 'ok',
    ...overrides,
  };
}

export const toolCalls: readonly ToolCall[] = [
  call(1),
  call(2, { name: 'Bash', ok: false }),
  call(3, { name: 'Edit', endedAt: null, ok: null }),
];

const feed: readonly FeedItem[] = [
  { kind: 'user', id: 'f1', at: NOW - 9 * MINUTE, text: 'Refactor the parser please.' },
  { kind: 'thinking', id: 'f2', at: NOW - 9 * MINUTE, text: 'Plan the change in steps.' },
  { kind: 'text', id: 'f3', at: NOW - 8 * MINUTE, text: 'Reading the parser first.' },
  {
    kind: 'tool_use',
    id: 'f4',
    at: NOW - 8 * MINUTE,
    name: 'Read',
    input: { file_path: '/src/parser.ts' },
  },
  {
    kind: 'tool_result',
    id: 'f5',
    at: NOW - 8 * MINUTE,
    toolUseId: 'f4',
    ok: true,
    text: '120 lines',
  },
  {
    kind: 'tool_result',
    id: 'f6',
    at: NOW - 7 * MINUTE,
    toolUseId: 'f4',
    ok: false,
    text: 'Exit 1',
  },
  { kind: 'system', id: 'f7', at: NOW - 6 * MINUTE, text: 'Compacted context.' },
];

export const agentState: AgentDetailState = {
  agent: mainAgent ?? null,
  session: firstSession ?? null,
  children: fleetState.agents.filter((node) => node.parentAgentId === 's1'),
  feed,
  toolCalls,
  requests,
  compactions: [NOW - 6 * MINUTE],
};

/** The fleet in three projects: s1 in a git repo, s2 in none, s3 in one made by hand. */
export const projectFleet: FleetState = {
  ...fleetState,
  projects: [
    { id: 'git:/r/web', name: 'web', kind: 'git', folder: '/r/web' },
    { id: 'm1', name: 'Course', kind: 'manual', folder: null },
    { id: 'm2', name: 'Empty', kind: 'manual', folder: null },
  ],
  sessionProjects: {
    s1: { projectId: 'git:/r/web', folder: '/r/web', ignored: false },
    s2: { projectId: null, folder: '/notes', ignored: false },
    s3: { projectId: 'm1', folder: '/class', ignored: false },
  },
};
