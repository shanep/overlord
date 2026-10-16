// Samples the machine every two seconds, but only while someone looks. Each
// read of the state counts as a look, and an open Activity panel reads it on
// every change, so sampling stops a few seconds after the panel closes.

import type { ActivityState } from '../../shared/activity.js';
import { messageOf } from '../app/errors.js';
import type { IntervalFunction } from '../app/process.js';

import type { SessionRef } from './build.js';
import { buildActivity, emptyActivity, sessionTrees } from './build.js';
import type { ProcessSnapshot } from './flags.js';
import type { RawSample, SampleDeps } from './sample.js';
import { Sampler } from './sample.js';

export const ACTIVITY_INTERVAL_MS = 2000;
/** Sampling stops once nobody has read the state for this long. */
const IDLE_MS = 3 * ACTIVITY_INTERVAL_MS;
const SOURCE = 'activity';

export interface ActivityDeps extends SampleDeps {
  readonly interval: IntervalFunction;
  /** The live sessions and their process ids. */
  readonly sessions: () => readonly SessionRef[];
  readonly onChange: () => void;
  readonly report: (source: string, message: string) => void;
}

export class ActivityMonitor {
  private readonly sampler: Sampler;
  private stopTimer: (() => void) | null = null;
  private lastReadAt = 0;
  private running: Promise<void> | null = null;
  private previous: RawSample | null = null;
  private histories: ReadonlyMap<number, readonly ProcessSnapshot[]> = new Map();
  private current: ActivityState = emptyActivity(ACTIVITY_INTERVAL_MS);

  constructor(private readonly deps: ActivityDeps) {
    this.sampler = new Sampler(deps);
  }

  /** The latest numbers. Reading starts sampling and keeps it going. */
  state(): ActivityState {
    this.lastReadAt = this.deps.clock();
    if (this.stopTimer === null) {
      this.stopTimer = this.deps.interval(() => {
        void this.tick();
      }, ACTIVITY_INTERVAL_MS);
      void this.tick();
    }
    return this.current;
  }

  /** True while the sampling timer runs. */
  get sampling(): boolean {
    return this.stopTimer !== null;
  }

  /** Takes one sample, unless one is running or nobody has looked lately. */
  async tick(): Promise<void> {
    if (this.deps.clock() - this.lastReadAt > IDLE_MS) {
      this.stop();
      return;
    }
    this.running ??= this.sample().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
    this.previous = null;
    this.histories = new Map();
  }

  private async sample(): Promise<void> {
    try {
      const sessions = this.deps.sessions();
      const folders = sessions.map((session) => session.cwd).filter((cwd) => cwd !== '');
      const current = await this.sampler.read(
        (rows) => sessionTrees(sessions, rows).flatMap((tree) => tree.rows.map((row) => row.pid)),
        folders,
      );
      const result = buildActivity({
        previous: this.previous,
        current,
        sessions,
        histories: this.histories,
        intervalMs: ACTIVITY_INTERVAL_MS,
        notes: this.sampler.notes,
      });
      this.previous = current;
      this.histories = result.histories;
      this.current = result.state;
      this.deps.onChange();
    } catch (error: unknown) {
      this.deps.report(SOURCE, messageOf(error));
    }
  }
}
