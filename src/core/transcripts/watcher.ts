// Tails the transcripts of active sessions and publishes changes on the bus.
// fs.watch makes updates quick where it works; a poll timer is the fallback
// and also catches state changes that come only from time passing.

import { watch } from 'node:fs';

import type { ApiRequest, FeedItem, ToolCall } from '../../shared/model.js';
import type { EventBus, EventName, OverlordEvents } from '../bus.js';

import type { IngestResult } from './accumulator.js';
import { SessionAccumulator } from './accumulator.js';
import { IncrementalReader } from './reader.js';
import type { LoadOptions, SessionFileInfo } from './scanner.js';
import { ingestLines, scanSessions } from './scanner.js';
import { listSubagentFiles, readSubagentMeta } from './subagents.js';

export interface WatchHandle {
  readonly close: () => void;
}

export type WatchFactory = (
  dir: string,
  onChange: () => void,
  onError: (error: unknown) => void,
) => WatchHandle;

/** Recursive fs.watch. Supported on macOS and on Linux since Node 20. */
export const defaultWatchFactory: WatchFactory = (dir, onChange, onError) => {
  const watcher = watch(dir, { recursive: true, persistent: false }, onChange);
  watcher.on('error', onError);
  return {
    close: (): void => {
      watcher.close();
    },
  };
};

export interface TranscriptWatcherOptions {
  readonly projectsDir: string;
  readonly bus: EventBus;
  /** Sessions whose files changed within this window are tailed. */
  readonly activeWindowMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  /** Null turns fs.watch off and leaves only polling. */
  readonly watchFactory?: WatchFactory | null;
  readonly accumulator?: LoadOptions;
}

export const DEFAULT_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 2000;
const SOURCE = 'transcripts';

interface TrackedFile {
  readonly reader: IncrementalReader;
  readonly agentId: string;
  readonly metaPath: string | null;
}

interface TrackedSession {
  readonly accumulator: SessionAccumulator;
  readonly files: Map<string, TrackedFile>;
  /** Last published JSON per entity key, so unchanged rows are not sent again. */
  readonly published: Map<string, string>;
}

interface ReadOutcome {
  readonly results: IngestResult[];
  readonly reset: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function changed(session: TrackedSession, key: string, value: unknown): boolean {
  const json = JSON.stringify(value);
  if (session.published.get(key) === json) {
    return false;
  }
  session.published.set(key, json);
  return true;
}

interface Batch {
  readonly tools: Map<string, ToolCall>;
  readonly requests: Map<string, ApiRequest>;
  readonly feed: Map<string, FeedItem[]>;
  readonly contexts: Set<string>;
  readonly compactions: { readonly agentId: string; readonly at: number }[];
}

/** Merge per-record results: the last version of each tool and request wins, feed items keep order. */
function collectBatch(results: readonly IngestResult[]): Batch {
  const batch: Batch = {
    tools: new Map(),
    requests: new Map(),
    feed: new Map(),
    contexts: new Set(),
    compactions: [],
  };
  for (const result of results) {
    for (const tool of result.tools) {
      batch.tools.set(tool.id, tool);
    }
    for (const request of result.requests) {
      batch.requests.set(request.messageId, request);
    }
    if (result.feed.length > 0) {
      const items = batch.feed.get(result.agentId) ?? [];
      items.push(...result.feed);
      batch.feed.set(result.agentId, items);
    }
    if (result.contextChanged) {
      batch.contexts.add(result.agentId);
    }
    for (const at of result.compactions) {
      batch.compactions.push({ agentId: result.agentId, at });
    }
  }
  return batch;
}

export class TranscriptWatcher {
  private readonly projectsDir: string;
  private readonly bus: EventBus;
  private readonly activeWindowMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly watchFactory: WatchFactory | null;
  private readonly loadOptions: LoadOptions;
  private readonly tracked = new Map<string, TrackedSession>();
  private timer: NodeJS.Timeout | null = null;
  private handle: WatchHandle | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private disposed = false;

  constructor(options: TranscriptWatcherOptions) {
    this.projectsDir = options.projectsDir;
    this.bus = options.bus;
    this.activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.watchFactory =
      options.watchFactory === undefined ? defaultWatchFactory : options.watchFactory;
    this.loadOptions = options.accumulator ?? {};
  }

  /** Start polling and watching. The first refresh runs right away. */
  async start(): Promise<void> {
    if (this.disposed || this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
    this.timer.unref();
    this.startWatching();
    await this.refresh();
  }

  /** The live accumulator for a tailed session. */
  session(sessionId: string): SessionAccumulator | undefined {
    return this.tracked.get(sessionId)?.accumulator;
  }

  sessionIds(): string[] {
    return [...this.tracked.keys()];
  }

  /** Run one scan and read cycle. Calls made while one runs share a single follow-up cycle. */
  async refresh(): Promise<void> {
    if (this.running !== null) {
      this.rerun = true;
      await this.running;
      return;
    }
    this.running = this.loop();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.handle?.close();
    this.handle = null;
  }

  private startWatching(): void {
    if (this.watchFactory === null) {
      return;
    }
    try {
      this.handle = this.watchFactory(
        this.projectsDir,
        () => {
          void this.refresh();
        },
        (error) => {
          this.reportError(error);
          this.handle?.close();
          this.handle = null;
        },
      );
    } catch (error: unknown) {
      this.reportError(error);
    }
  }

  private async loop(): Promise<void> {
    let again = true;
    while (again) {
      this.rerun = false;
      await this.cycle();
      again = this.wantsRerun();
    }
  }

  private wantsRerun(): boolean {
    return this.rerun && !this.disposed;
  }

  private async cycle(): Promise<void> {
    const sessions = await scanSessions(this.projectsDir);
    const now = this.now();
    const active = new Set<string>();
    for (const info of sessions) {
      if (this.disposed) {
        return;
      }
      if (now - info.mtimeMs <= this.activeWindowMs) {
        active.add(info.sessionId);
        await this.poll(info, now);
      }
    }
    for (const [sessionId, session] of this.tracked) {
      if (!active.has(sessionId)) {
        this.publish(session, [], now);
        this.tracked.delete(sessionId);
      }
    }
  }

  private async poll(info: SessionFileInfo, now: number): Promise<void> {
    try {
      let session = this.tracked.get(info.sessionId) ?? this.track(info);
      let outcome = await this.readSession(session, info);
      if (outcome.reset) {
        session = this.track(info);
        outcome = await this.readSession(session, info);
      }
      this.publish(session, outcome.results, now);
    } catch (error: unknown) {
      this.reportError(error);
    }
  }

  private track(info: SessionFileInfo): TrackedSession {
    const session: TrackedSession = {
      accumulator: new SessionAccumulator({
        ...this.loadOptions,
        sessionId: info.sessionId,
        transcriptPath: info.transcriptPath,
      }),
      files: new Map([
        [
          info.transcriptPath,
          {
            reader: new IncrementalReader(info.transcriptPath),
            agentId: info.sessionId,
            metaPath: null,
          },
        ],
      ]),
      published: new Map(),
    };
    this.tracked.set(info.sessionId, session);
    return session;
  }

  private async readSession(session: TrackedSession, info: SessionFileInfo): Promise<ReadOutcome> {
    for (const file of await listSubagentFiles(info.sessionDir)) {
      if (!session.files.has(file.transcriptPath)) {
        session.files.set(file.transcriptPath, {
          reader: new IncrementalReader(file.transcriptPath),
          agentId: file.agentId,
          metaPath: file.metaPath,
        });
      }
    }
    const results: IngestResult[] = [];
    for (const [filePath, file] of session.files) {
      if (file.metaPath !== null && !session.accumulator.hasSubagentMeta(file.agentId)) {
        const meta = await readSubagentMeta(file.metaPath);
        session.accumulator.addSubagent(file.agentId, meta, filePath);
      }
      const read = await file.reader.read();
      if (read.reset) {
        return { results: [], reset: true };
      }
      for (const result of ingestLines(session.accumulator, read.lines, file.agentId)) {
        results.push(result);
      }
    }
    return { results, reset: false };
  }

  private publish(session: TrackedSession, results: readonly IngestResult[], now: number): void {
    const accumulator = session.accumulator;
    const summary = accumulator.summary(now);
    if (changed(session, 'session', summary)) {
      this.emit('session.upserted', summary);
    }
    for (const agent of accumulator.agents(now)) {
      if (changed(session, `agent:${agent.id}`, agent)) {
        this.emit('agent.upserted', agent);
      }
    }
    this.publishResults(accumulator, results);
  }

  private publishResults(accumulator: SessionAccumulator, results: readonly IngestResult[]): void {
    const batch = collectBatch(results);
    const sessionId = accumulator.sessionId;
    for (const tool of batch.tools.values()) {
      this.emit('tool.upserted', tool);
    }
    for (const request of batch.requests.values()) {
      this.emit('request.recorded', request);
    }
    for (const [agentId, items] of batch.feed) {
      this.emit('feed.appended', { sessionId, agentId, items });
    }
    for (const agentId of batch.contexts) {
      this.emit('context.updated', accumulator.observedContext(agentId));
    }
    for (const compaction of batch.compactions) {
      this.emit('compaction.recorded', { sessionId, ...compaction });
    }
  }

  private reportError(error: unknown): void {
    this.emit('source.error', { source: SOURCE, message: messageOf(error) });
  }

  /** Nothing reaches the bus after dispose, even from a cycle that was already running. */
  private emit<K extends EventName>(name: K, payload: OverlordEvents[K]): void {
    if (!this.disposed) {
      this.bus.emit(name, payload);
    }
  }
}
