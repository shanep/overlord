// Builds what each session's Fleet row shows about its progress: its task
// list with an estimate of what is left, where its subagents spent their
// tokens, and how much of its token budget it has used.

import type {
  AgentNode,
  ApiRequest,
  SessionSummary,
  TokenUsage,
  ToolCall,
} from '../../shared/model.js';
import { promptTokens } from '../../shared/model.js';
import type {
  FleetProgress,
  SubagentBurn,
  SubagentSpend,
  TaskProgress,
} from '../../shared/progress.js';
import type { PlanLimit } from '../../shared/protocol.js';
import { totalCost } from '../transcripts/accumulator.js';

import { taskProgress } from './estimate.js';
import { readTaskList } from './tasks.js';

/** What the Fleet's progress is built from: a main thread's task tool calls and the session's requests. */
export interface ProgressActivity {
  readonly taskCalls: readonly ToolCall[];
  readonly requests: readonly ApiRequest[];
}

/** Subagents named in a row's tooltip. */
const TOP_SPENDERS = 3;

/** Tokens in and out, the way the Fleet's token column counts them. */
export function usedTokens(usage: TokenUsage): number {
  return promptTokens(usage) + usage.output;
}

export interface ProgressInputs {
  readonly sessions: readonly SessionSummary[];
  readonly agents: readonly AgentNode[];
  readonly activity: ReadonlyMap<string, ProgressActivity>;
  /** Token budgets by session id. */
  readonly budgets: Readonly<Record<string, number>>;
  /** The plan's 5 hour window, when /usage reported it. */
  readonly window: PlanLimit | null;
  readonly now: number;
}

function isFinished(session: SessionSummary): boolean {
  return session.state === 'done' || session.state === 'failed';
}

function tasksOf(
  session: SessionSummary,
  activity: ProgressActivity | undefined,
  input: ProgressInputs,
): TaskProgress | null {
  const list = readTaskList(activity?.taskCalls ?? []);
  if (list === null) {
    return null;
  }
  // The store may have dropped a long session's oldest requests. Then less
  // comes off the total and the estimate errs high, never low.
  const before = (activity?.requests ?? []).filter((request) => request.timestamp < list.startedAt);
  const beforeCost = totalCost(before) ?? 0;
  const progress = taskProgress({
    list,
    lastActiveAt: session.updatedAt,
    now: input.now,
    tokensSpent: Math.max(
      0,
      usedTokens(session.usage) -
        before.reduce((sum, request) => sum + usedTokens(request.usage), 0),
    ),
    costSpentUsd: session.costUsd === null ? null : Math.max(0, session.costUsd - beforeCost),
    window: input.window,
  });
  return isFinished(session) ? { ...progress, estimate: null } : progress;
}

function costsByAgent(requests: readonly ApiRequest[]): Readonly<Record<string, number>> {
  const grouped = new Map<string, ApiRequest[]>();
  for (const request of requests) {
    const list = grouped.get(request.agentId);
    if (list === undefined) {
      grouped.set(request.agentId, [request]);
    } else {
      list.push(request);
    }
  }
  const out: Record<string, number> = {};
  for (const [agentId, mine] of grouped) {
    const cost = totalCost(mine);
    if (cost !== null) {
      out[agentId] = cost;
    }
  }
  return out;
}

function subagentsOf(
  session: SessionSummary,
  agents: readonly AgentNode[],
  activity: ProgressActivity | undefined,
): SubagentBurn | null {
  const mine = agents.filter((agent) => agent.sessionId === session.id && agent.id !== session.id);
  if (mine.length === 0) {
    return null;
  }
  const spends: SubagentSpend[] = mine.map((agent) => ({
    agentId: agent.id,
    description: agent.description === '' ? agent.agentType : agent.description,
    tokens: usedTokens(agent.usage),
    running: agent.state === 'running',
  }));
  const running = spends.filter((spend) => spend.running).length;
  return {
    running,
    finished: spends.length - running,
    tokens: spends.reduce((sum, spend) => sum + spend.tokens, 0),
    top: spends.toSorted((left, right) => right.tokens - left.tokens).slice(0, TOP_SPENDERS),
    costs: costsByAgent(
      (activity?.requests ?? []).filter((request) => request.agentId !== session.id),
    ),
  };
}

/** Progress for each session that has a task list, subagents or a budget, by session id. */
export function fleetProgress(input: ProgressInputs): Readonly<Record<string, FleetProgress>> {
  const out: Record<string, FleetProgress> = {};
  for (const session of input.sessions) {
    const activity = input.activity.get(session.id);
    const limit = input.budgets[session.id];
    const progress: FleetProgress = {
      tasks: tasksOf(session, activity, input),
      subagents: subagentsOf(session, input.agents, activity),
      budget: limit === undefined ? null : { tokens: limit, used: usedTokens(session.usage) },
    };
    if (progress.tasks !== null || progress.subagents !== null || progress.budget !== null) {
      out[session.id] = progress;
    }
  }
  return out;
}
