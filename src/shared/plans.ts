// Plans: a goal split into tasks that separate sessions work on in parallel,
// each in its own worktree, started as the tasks they depend on land.

export type PlanTaskState = 'waiting' | 'queued' | 'running' | 'landed' | 'failed' | 'stopped';

export interface PlanTask {
  /** Short and unique within the plan, such as "store". */
  readonly id: string;
  readonly title: string;
  /** What the session is told to do, written to stand on its own. */
  readonly prompt: string;
  /** Ids of the tasks that must land first. */
  readonly dependsOn: readonly string[];
  /** Files the planner expects it to change, so two parallel tasks do not clash. */
  readonly files: readonly string[];
  readonly state: PlanTaskState;
  /** The Launcher run working on it, or null before it starts. */
  readonly runId: string | null;
  readonly sessionId: string | null;
  /** The commit it landed as. */
  readonly landedSha: string | null;
  /** Why it failed or stopped, or null. */
  readonly note: string | null;
}

export type PlanState = 'drafting' | 'draft' | 'running' | 'done' | 'stopped' | 'failed';

export interface Plan {
  readonly id: string;
  readonly goal: string;
  /** The repository the tasks work in. */
  readonly cwd: string;
  readonly createdAt: number;
  readonly state: PlanState;
  /** The planner's one paragraph on how it split the work. */
  readonly summary: string;
  readonly tasks: readonly PlanTask[];
  /** Why drafting failed, or null. */
  readonly error: string | null;
}
