// Keeps the background jobs waiting on the user or finished current for the
// fleet. Each read runs `claude agents --json --all`, which takes a fraction
// of a second, so it is polled a little less often than the session registry.

import type { BackgroundJob } from '../surfaces/jobs.js';
import { backgroundJobs } from '../surfaces/jobs.js';
import { readClaudeAgents } from '../surfaces/live.js';
import type { ExecFunction } from '../surfaces/process.js';

export interface JobsDeps {
  readonly exec: ExecFunction;
  /** The claude binary, looked up on each read so a settings change takes effect. */
  readonly claudeBin: () => Promise<string>;
  /** Holds these sessions' transcripts in the fleet past the idle and active windows. */
  readonly keep: (sessionIds: readonly string[]) => Promise<void>;
  readonly onChange: () => void;
  readonly report: (source: string, message: string) => void;
}

export const JOBS_REFRESH_MS = 10_000;
const SOURCE = 'background jobs';

export class BackgroundJobs {
  private current: readonly BackgroundJob[] = [];
  private lastError: string | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: JobsDeps) {}

  /** Background jobs waiting on the user or finished, oldest first. */
  get value(): readonly BackgroundJob[] {
    return this.current;
  }

  /** Ask Claude Code again. Calls made while one runs share it. */
  async refresh(): Promise<void> {
    this.running ??= this.load().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async load(): Promise<void> {
    const result = await readClaudeAgents(this.deps.exec, {
      claudeBin: await this.deps.claudeBin(),
      includeCompleted: true,
    });
    // Say so once per distinct problem rather than on every poll.
    const error = result.errors.map((item) => item.message).join('; ');
    if (error !== '' && error !== this.lastError) {
      this.deps.report(SOURCE, error);
    }
    this.lastError = error === '' ? null : error;
    // A failed read keeps the last list, so done rows do not flicker away.
    if (result.items.length === 0 && result.errors.length > 0) {
      return;
    }
    const next = backgroundJobs(result.items);
    if (JSON.stringify(next) === JSON.stringify(this.current)) {
      return;
    }
    this.current = next;
    await this.deps.keep(next.map((job) => job.sessionId));
    this.deps.onChange();
  }
}
