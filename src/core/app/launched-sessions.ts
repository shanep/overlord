// The sessions the Launcher started. They stay in the fleet however long they
// have been quiet, across reloads too, until someone removes them by hand.

import type { LaunchRun } from '../../shared/protocol.js';

import { readLaunched, writeLaunched } from './storage.js';

export interface LaunchedSessionsOptions {
  /** launched.json in the storage folder. */
  readonly file: string;
  /** Tells the transcript watcher which sessions to hold. */
  readonly keep: (sessionIds: readonly string[]) => Promise<void>;
  readonly onChange: () => void;
  readonly report: (source: string, message: string) => void;
}

const SOURCE = 'launched';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LaunchedSessions {
  private readonly options: LaunchedSessionsOptions;
  private ids: readonly string[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(options: LaunchedSessionsOptions) {
    this.options = options;
  }

  /** Reads the saved list and holds those sessions in the fleet. */
  async load(): Promise<void> {
    await this.enqueue(async () => {
      try {
        const saved = await readLaunched(this.options.file);
        this.ids = [...new Set([...saved, ...this.ids])];
      } catch (error) {
        this.options.report(SOURCE, messageOf(error));
      }
      await this.options.keep(this.ids);
    });
    this.options.onChange();
  }

  list(): readonly string[] {
    return this.ids;
  }

  has(sessionId: string): boolean {
    return this.ids.includes(sessionId);
  }

  /** Adds each run's session once it has one, for as long as the launcher runs. */
  track(launcher: { onChange: (listener: (run: LaunchRun) => void) => () => void }): () => void {
    return launcher.onChange((run) => {
      if (run.sessionId !== null) {
        void this.add(run.sessionId);
      }
    });
  }

  async add(sessionId: string): Promise<void> {
    if (this.has(sessionId)) {
      return;
    }
    this.ids = [...this.ids, sessionId];
    await this.save();
  }

  /** False when the session was not in the list. */
  async remove(sessionId: string): Promise<boolean> {
    if (!this.has(sessionId)) {
      return false;
    }
    this.ids = this.ids.filter((id) => id !== sessionId);
    await this.save();
    return true;
  }

  /** Writes the list as it stands when the write runs, so queued saves end on the latest. */
  private async save(): Promise<void> {
    this.options.onChange();
    await this.enqueue(async () => {
      try {
        await writeLaunched(this.options.file, this.ids);
      } catch (error) {
        this.options.report(SOURCE, messageOf(error));
      }
      await this.options.keep(this.ids);
    });
  }

  /** Resolves once every queued write has landed, so nothing writes after teardown. */
  async idle(): Promise<void> {
    await this.queue;
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task);
    this.queue = next.catch((error: unknown) => {
      this.options.report(SOURCE, messageOf(error));
    });
    return next;
  }
}
