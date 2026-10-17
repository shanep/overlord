// How far along a session is by its own task list, what it should take to
// finish, where its subagents spent their tokens, and its token budget.

/** Under this many finished tasks an estimate is rough. */
export const SOLID_BASIS = 3;

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/** One step in an agent's task list, as the agent last wrote it. */
export interface TaskItem {
  readonly id: string;
  readonly subject: string;
  readonly status: TaskStatus;
}

/** A session's task list and when the agent first wrote it. */
export interface TaskList {
  readonly items: readonly TaskItem[];
  readonly startedAt: number;
}

/** What is left, projected from the share of the task list done so far. */
export interface ProgressEstimate {
  /** Tokens in and out, the way the Fleet counts them. */
  readonly tokensLeft: number;
  /** Null when the session's cost is not known. */
  readonly costLeftUsd: number | null;
  readonly msLeft: number;
  readonly finishAt: number;
  /** Finished tasks the projection rests on. Under three it is rough. */
  readonly basis: number;
  /** When the 5 hour window runs out at the fleet's pace, if that comes before finishAt. */
  readonly limitRunsOutAt: number | null;
}

export interface TaskProgress {
  readonly done: number;
  readonly inProgress: number;
  /** Tasks in the list, not counting deleted ones. */
  readonly total: number;
  /** The first task in progress, or null while none is. */
  readonly current: string | null;
  readonly startedAt: number;
  /** Tokens the session used since the task list started. */
  readonly tokensSpent: number;
  /** Null until a task is done, and once all of them are. */
  readonly estimate: ProgressEstimate | null;
}

/** A subagent that used a lot of the session's tokens. */
export interface SubagentSpend {
  readonly agentId: string;
  readonly description: string;
  readonly tokens: number;
  readonly running: boolean;
}

export interface SubagentBurn {
  readonly running: number;
  readonly finished: number;
  /** Tokens across every subagent. */
  readonly tokens: number;
  /** The biggest spenders, most tokens first. */
  readonly top: readonly SubagentSpend[];
  /** Cost of each subagent at list price, by agent id, when it is known. */
  readonly costs: Readonly<Record<string, number>>;
}

/** A token budget set on a session, and how much of it is used. */
export interface BudgetUse {
  readonly tokens: number;
  readonly used: number;
}

/** What a session's Fleet row shows about its progress. */
export interface FleetProgress {
  readonly tasks: TaskProgress | null;
  readonly subagents: SubagentBurn | null;
  readonly budget: BudgetUse | null;
}
