// Builders for the summary, agent and rate limit records the reducer keeps.

import type { AgentId, RateLimitWindow } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import {
  ZERO_USAGE,
  type AgentNode,
  type SessionState,
  type SessionSummary,
} from '../../shared/model.js';
import type { RateLimits } from '../../shared/protocol.js';
import type {
  RateLimitEvent,
  RateLimitWindowReport,
  SubagentStartedEvent,
} from '../agents/shared/events.js';

import type { EndReason } from './events.js';

export interface MapperConfig {
  readonly agent: AgentId;
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: string | null;
  readonly now: () => number;
}

/** How the session ends. A completed run that already failed a turn stays failed. */
export function endState(reason: EndReason, state: SessionState): SessionState {
  if (reason === 'failed' || (reason === 'completed' && state === 'failed')) {
    return 'failed';
  }
  return 'done';
}

export const NO_RATE_LIMITS: RateLimits = { fiveHourPct: null, sevenDayPct: null, resetsAt: null };

export function initialSummary(config: MapperConfig, at: number): SessionSummary {
  return {
    id: config.sessionId,
    agent: config.agent,
    surface: 'overlord',
    title: config.title,
    cwd: config.cwd,
    state: 'idle',
    startedAt: at,
    updatedAt: at,
    usage: ZERO_USAGE,
    costUsd: 0,
    model: config.model,
    effort: config.effort,
    permissionMode: config.permissionMode,
    pid: null,
    transcriptPath: null,
    gitBranch: null,
    version: null,
    agentCount: 0,
    contextFill: null,
    recap: null,
    lastPrompt: null,
    lastPromptAt: null,
  };
}

export function mainAgent(config: MapperConfig, at: number): AgentNode {
  return {
    id: config.sessionId,
    sessionId: config.sessionId,
    parentAgentId: null,
    parentToolUseId: null,
    agentType: 'main',
    description: config.title,
    spawnDepth: 0,
    background: false,
    state: 'idle',
    startedAt: at,
    endedAt: null,
    transcriptPath: null,
    usage: ZERO_USAGE,
    toolCallCount: 0,
    currentTool: null,
    model: config.model,
  };
}

export function subagent(sessionId: string, event: SubagentStartedEvent, at: number): AgentNode {
  return {
    id: event.agentId,
    sessionId,
    parentAgentId: event.parentAgentId ?? sessionId,
    parentToolUseId: event.parentToolUseId,
    agentType: event.agentType,
    description: event.description,
    spawnDepth: event.spawnDepth,
    background: event.background,
    state: 'running',
    startedAt: at,
    endedAt: null,
    transcriptPath: null,
    usage: ZERO_USAGE,
    toolCallCount: 0,
    currentTool: null,
    model: event.model,
  };
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** Claude Code reports its windows by id alone. */
const KNOWN_LABELS: Readonly<Record<string, string>> = {
  five_hour: '5 hour',
  seven_day: '7 day',
  seven_day_opus: '7 day Opus',
  seven_day_sonnet: '7 day Sonnet',
};

/** "5 hour", "7 day" or "30 day" from the window's length, else from its id. */
export function windowLabel(id: string, minutes: number | null): string {
  if (minutes !== null && minutes > 0) {
    if (minutes % MINUTES_PER_DAY === 0) {
      return `${String(minutes / MINUTES_PER_DAY)} day`;
    }
    if (minutes % MINUTES_PER_HOUR === 0) {
      return `${String(minutes / MINUTES_PER_HOUR)} hour`;
    }
    return `${String(minutes)} minute`;
  }
  return KNOWN_LABELS[id] ?? id.replaceAll('_', ' ');
}

/** The windows with one report folded in, each agent's window kept once by id. */
function withWindow(
  windows: readonly RateLimitWindow[],
  agent: AgentId,
  report: RateLimitWindowReport,
): RateLimitWindow[] {
  const known = windows.find((window) => window.agent === agent && window.id === report.id);
  const next: RateLimitWindow = {
    agent,
    id: report.id,
    label: windowLabel(report.id, report.windowMinutes),
    usedPct: report.usedPct ?? known?.usedPct ?? null,
    resetsAt: report.resetsAt ?? known?.resetsAt ?? null,
  };
  return known === undefined
    ? [...windows, next]
    : windows.map((window) => (window === known ? next : window));
}

/** Claude Code's 5 hour and 7 day windows in the fields the Fleet header reads. */
function withClaudeWindow(current: RateLimits, window: RateLimitWindowReport): RateLimits {
  if (window.id === 'five_hour') {
    return {
      ...current,
      fiveHourPct: window.usedPct ?? current.fiveHourPct,
      resetsAt: window.resetsAt ?? current.resetsAt,
    };
  }
  if (window.id === 'seven_day') {
    return { ...current, sevenDayPct: window.usedPct ?? current.sevenDayPct };
  }
  return current;
}

/**
 * Folds one rate limit report into the known limits. Every window goes in
 * windows, and Claude Code's 5 hour and 7 day ones also fill the two fields
 * the Fleet header reads. Returns null when the report has no windows.
 */
export function applyRateLimit(
  limits: RateLimits,
  event: RateLimitEvent,
  agent: AgentId,
): RateLimits | null {
  let next: RateLimits | null = null;
  for (const window of event.windows) {
    const prior = next ?? limits;
    const current: RateLimits = {
      ...prior,
      windows: withWindow(prior.windows ?? [], agent, window),
    };
    next = agent === CLAUDE_CODE ? withClaudeWindow(current, window) : current;
  }
  return next;
}
