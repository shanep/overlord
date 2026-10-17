// Tails Claude Code's transcripts and publishes changes on the bus. The loop
// lives in agents/shared/tailing-watcher.ts, and this runs it with the Claude
// observer pointed at one projects folder.

import { claudeObserver } from '../agents/claude/observer.js';
import type { ClaudeRecords } from '../agents/claude/observer.js';
import type { TailingWatcherOptions } from '../agents/shared/tailing-watcher.js';
import { TailingWatcher } from '../agents/shared/tailing-watcher.js';

import type { SessionAccumulator } from './accumulator.js';
import type { LoadOptions } from './scanner.js';

export type { WatchFactory, WatchHandle } from '../agents/shared/tailing-watcher.js';
export {
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_IDLE_WINDOW_MS,
  DEFAULT_POLL_INTERVAL_MS,
  defaultWatchFactory,
} from '../agents/shared/tailing-watcher.js';

export interface TranscriptWatcherOptions extends Omit<
  TailingWatcherOptions<ClaudeRecords>,
  'observer'
> {
  readonly projectsDir: string;
  readonly accumulator?: LoadOptions;
}

export class TranscriptWatcher extends TailingWatcher<ClaudeRecords> {
  constructor(options: TranscriptWatcherOptions) {
    const { projectsDir, accumulator, ...rest } = options;
    super({
      ...rest,
      observer: claudeObserver({ projectsDir, load: accumulator }),
    });
  }

  /** The live accumulator for a tailed session. */
  session(sessionId: string): SessionAccumulator | undefined {
    return this.accumulator(sessionId)?.inner;
  }
}
