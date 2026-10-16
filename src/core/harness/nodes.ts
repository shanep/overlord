// Builders for the summary, agent and rate limit records the mapper keeps.

import {
  ZERO_USAGE,
  type AgentNode,
  type PermissionMode,
  type SessionSummary,
} from '../../shared/model.js';
import type { RateLimits } from '../../shared/protocol.js';

import { toEpochMs } from './events.js';
import type { RateLimitMessage, TaskStartedMessage } from './messages.js';

export interface MapperConfig {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: PermissionMode | null;
  readonly now: () => number;
}

export const NO_RATE_LIMITS: RateLimits = { fiveHourPct: null, sevenDayPct: null, resetsAt: null };

export function initialSummary(config: MapperConfig, at: number): SessionSummary {
  return {
    id: config.sessionId,
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

export function subagent(sessionId: string, message: TaskStartedMessage, at: number): AgentNode {
  return {
    id: message.task_id,
    sessionId,
    parentAgentId: message.parent_task_id ?? sessionId,
    parentToolUseId: message.tool_use_id ?? null,
    agentType: message.subagent_type ?? message.task_type ?? 'task',
    description: message.description,
    spawnDepth: message.spawn_depth ?? 1,
    background: message.is_backgrounded ?? false,
    state: 'running',
    startedAt: at,
    endedAt: null,
    transcriptPath: null,
    usage: ZERO_USAGE,
    toolCallCount: 0,
    currentTool: null,
    model: null,
  };
}

/**
 * Folds one rate limit event into the known limits. Returns null for windows
 * the bus has no slot for (per-model and overage limits).
 */
export function applyRateLimit(limits: RateLimits, message: RateLimitMessage): RateLimits | null {
  const info = message.rate_limit_info;
  // utilization is a fraction of the window; the bus carries percent.
  const pct = info.utilization === undefined ? null : info.utilization * 100;
  if (info.rateLimitType === 'five_hour') {
    return {
      ...limits,
      fiveHourPct: pct ?? limits.fiveHourPct,
      resetsAt: toEpochMs(info.resetsAt) ?? limits.resetsAt,
    };
  }
  if (info.rateLimitType === 'seven_day') {
    return { ...limits, sevenDayPct: pct ?? limits.sevenDayPct };
  }
  return null;
}
