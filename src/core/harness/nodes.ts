// Builders for the summary, agent and rate limit records the reducer keeps.

import type { AgentId } from '../../shared/agents.js';
import {
  ZERO_USAGE,
  type AgentNode,
  type SessionState,
  type SessionSummary,
} from '../../shared/model.js';
import type { RateLimits } from '../../shared/protocol.js';
import type { RateLimitEvent, SubagentStartedEvent } from '../agents/shared/events.js';

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

/**
 * Folds one rate limit report into the known limits. Returns null when no
 * window has a slot on the bus (per-model, overage and other agents' windows).
 */
export function applyRateLimit(limits: RateLimits, event: RateLimitEvent): RateLimits | null {
  let next: RateLimits | null = null;
  for (const window of event.windows) {
    const current: RateLimits = next ?? limits;
    if (window.id === 'five_hour') {
      next = {
        ...current,
        fiveHourPct: window.usedPct ?? current.fiveHourPct,
        resetsAt: window.resetsAt ?? current.resetsAt,
      };
    } else if (window.id === 'seven_day') {
      next = { ...current, sevenDayPct: window.usedPct ?? current.sevenDayPct };
    }
  }
  return next;
}
