import { appendFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COPILOT, CODEX } from '../../../shared/agents.js';
import type { AgentNode, ApiRequest, SessionSummary } from '../../../shared/model.js';
import { ZERO_USAGE } from '../../../shared/model.js';
import { agent, session, toolCall } from '../../app/test-helpers/fixtures.js';
import type { EventName, OverlordEvents } from '../../bus.js';
import { EventBus } from '../../bus.js';
import { makeTemporaryDirectory, removeDir } from '../../transcripts/test-helpers/fixtures.js';
import type {
  ObservedSession,
  RecordAccumulator,
  RecordDelta,
  SessionObserver,
  TailedFile,
} from '../types.js';

import { TailingWatcher } from './tailing-watcher.js';

const NOW = 1_800_000_000_000;

/** One line of the fake agents' files. Subagent records name their thread inline, like Copilot's. */
interface FakeLine {
  readonly type: 'prompt' | 'reply' | 'tool' | 'usage' | 'limit';
  readonly agentId?: string;
  readonly id?: string;
  /** For a limit line: when it was reported and the percent used. */
  readonly at?: number;
  readonly used?: number;
}

function isFakeLine(value: unknown): value is FakeLine {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function request(sessionId: string, id: string): ApiRequest {
  return {
    sessionId,
    agentId: sessionId,
    messageId: id,
    requestId: null,
    timestamp: NOW,
    model: 'gpt-5-mini',
    usage: ZERO_USAGE,
    costUsd: null,
    ttftMs: null,
    durationMs: null,
  };
}

/** Folds fake lines. It has no context and no meta files, so it leaves both optional parts out. */
class FakeRecords implements RecordAccumulator {
  private readonly threads = new Set<string>();
  private open = false;

  constructor(
    private readonly agentName: string,
    private readonly sessionId: string,
  ) {
    this.threads.add(sessionId);
  }

  ingest(line: string, fileAgent: string): RecordDelta | null {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isFakeLine(value)) {
      return null;
    }
    const agentId = value.agentId ?? fileAgent;
    this.threads.add(agentId);
    this.open = value.type === 'prompt' || value.type === 'tool';
    const id = value.id ?? 'x';
    return {
      agentId,
      tools: value.type === 'tool' ? [toolCall(this.sessionId, agentId, id, {})] : [],
      requests: value.type === 'usage' ? [request(this.sessionId, id)] : [],
      feed: [],
      contextChanged: true,
      compactions: [],
      ...(value.type === 'limit'
        ? {
            rateLimits: {
              at: value.at ?? 0,
              windows: [
                {
                  agent: this.agentName,
                  id: 'primary',
                  label: '5 hour',
                  usedPct: value.used ?? null,
                  resetsAt: null,
                },
              ],
            },
          }
        : {}),
    };
  }

  summary(): SessionSummary {
    return session(this.sessionId, { agent: this.agentName, agentCount: this.threads.size - 1 });
  }

  agents(): AgentNode[] {
    return [...this.threads].map((id) => agent(this.sessionId, id));
  }

  busy(): boolean {
    return this.open;
  }
}

async function describeFile(sessionId: string, file: string): Promise<ObservedSession> {
  const info = await stat(file);
  return { sessionId, transcriptPath: file, mtimeMs: info.mtimeMs, size: info.size };
}

/** Neither fake agent writes subagents to their own files. */
async function noChildren(): Promise<readonly TailedFile[]> {
  await Promise.resolve();
  return [];
}

/** Copilot's layout: <root>/<uuid>/events.jsonl, subagents inline. */
function copilotObserver(root: string): SessionObserver<FakeRecords> {
  return {
    source: 'copilot',
    watchRoot: null,
    scan: async (): Promise<ObservedSession[]> => {
      const ids = await readdir(root);
      return Promise.all(
        ids.map(async (id) => describeFile(id, path.join(root, id, 'events.jsonl'))),
      );
    },
    childFiles: noChildren,
    makeAccumulator: (info) => new FakeRecords(COPILOT, info.sessionId),
  };
}

const ROLLOUT = /^rollout-.+-(?<id>[0-9a-f-]{36})\.jsonl$/u;

/** Codex's layout: <root>/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl. */
function codexObserver(root: string): SessionObserver<FakeRecords> {
  return {
    source: 'codex',
    watchRoot: root,
    scan: async (): Promise<ObservedSession[]> => {
      const found: ObservedSession[] = [];
      for (const entry of await readdir(root, { recursive: true })) {
        const id = ROLLOUT.exec(path.basename(entry))?.groups?.['id'];
        if (id !== undefined) {
          found.push(await describeFile(id, path.join(root, entry)));
        }
      }
      return found;
    },
    childFiles: noChildren,
    makeAccumulator: (info) => new FakeRecords(CODEX, info.sessionId),
  };
}

function lines(records: readonly FakeLine[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

function capture(bus: EventBus): { name: EventName; payload: unknown }[] {
  const seen: { name: EventName; payload: unknown }[] = [];
  const names: EventName[] = [
    'session.upserted',
    'agent.upserted',
    'tool.upserted',
    'request.recorded',
    'context.updated',
    'session.removed',
    'source.error',
  ];
  for (const name of names) {
    bus.on(name, (payload: OverlordEvents[typeof name]) => {
      seen.push({ name, payload });
    });
  }
  return seen;
}

function count(events: readonly { name: EventName }[], name: EventName): number {
  return events.filter((event) => event.name === name).length;
}

/** A day after now, so no session is active and only the startup read can find limits. */
function aDayLater(): number {
  return Date.now() + 24 * 60 * 60_000;
}

describe('TailingWatcher with other agents', () => {
  let root = '';
  const watchers: TailingWatcher<FakeRecords>[] = [];

  beforeEach(async () => {
    root = await makeTemporaryDirectory();
  });

  afterEach(async () => {
    for (const watcher of watchers.splice(0)) {
      watcher.dispose();
    }
    await removeDir(root);
  });

  function make(
    observer: SessionObserver<FakeRecords>,
    bus: EventBus,
    now: () => number = Date.now,
  ): TailingWatcher<FakeRecords> {
    const watcher = new TailingWatcher({
      observer,
      bus,
      now,
      watchFactory: (): never => {
        throw new Error('this observer has nothing to watch');
      },
    });
    watchers.push(watcher);
    return watcher;
  }

  it('tails a Copilot session folder with its subagents inline', async () => {
    const id = '11111111-1111-4111-8111-000000000001';
    const file = path.join(root, id, 'events.jsonl');
    await mkdir(path.dirname(file));
    await writeFile(file, `${lines([{ type: 'prompt' }])}not json\n"a string"\n`);
    const bus = new EventBus();
    const events = capture(bus);
    const watcher = make(copilotObserver(root), bus);
    await watcher.start();
    expect(watcher.sessionIds()).toStrictEqual([id]);
    expect(watcher.busy(id)).toBe(true);
    expect(watcher.busy('nobody')).toBe(false);
    expect(events.find((event) => event.name === 'session.upserted')?.payload).toMatchObject({
      id,
      agent: COPILOT,
    });
    await appendFile(file, lines([{ type: 'tool', agentId: 'sub1', id: 'call1' }]));
    await watcher.refresh();
    expect(
      watcher
        .accumulator(id)
        ?.agents()
        .map((node) => node.id),
    ).toStrictEqual([id, 'sub1']);
    expect(count(events, 'tool.upserted')).toBe(1);
    expect(count(events, 'context.updated')).toBe(0);
    expect(count(events, 'source.error')).toBe(0);
    const before = events.length;
    await watcher.refresh();
    expect(events).toHaveLength(before);
  });

  it('finds Codex rollout files in dated folders and sends a call once when usage is written twice', async () => {
    const id = '019a0000-6060-7000-8000-000000000001';
    const day = path.join(root, '2026', '10', '16');
    await mkdir(day, { recursive: true });
    await writeFile(
      path.join(day, `rollout-2026-10-16T22-06-42-${id}.jsonl`),
      lines([
        { type: 'prompt' },
        { type: 'usage', id: 'resp_1' },
        { type: 'usage', id: 'resp_1' },
        { type: 'reply' },
      ]),
    );
    await writeFile(path.join(day, 'notes.txt'), 'not a rollout');
    const bus = new EventBus();
    const events = capture(bus);
    const watcher = make(codexObserver(root), bus);
    await watcher.start();
    expect(watcher.sessionIds()).toStrictEqual([id]);
    expect(watcher.busy(id)).toBe(false);
    expect(count(events, 'request.recorded')).toBe(1);
    expect(events.find((event) => event.name === 'source.error')?.payload).toStrictEqual({
      source: 'codex',
      message: 'this observer has nothing to watch',
    });
  });

  it('reads the newest quiet sessions once at startup for their limits, when the agent writes them', async () => {
    const day = path.join(root, '2026', '10', '16');
    await mkdir(day, { recursive: true });
    const rollout = (n: number): string =>
      path.join(
        day,
        `rollout-2026-10-16T22-06-42-019a0000-6060-7000-8000-00000000000${String(n)}.jsonl`,
      );
    await writeFile(rollout(1), lines([{ type: 'limit', at: 200, used: 50 }, { type: 'reply' }]));
    await writeFile(rollout(2), lines([{ type: 'limit', at: 100, used: 10 }]));
    await writeFile(rollout(3), lines([{ type: 'reply' }]));
    const used = async (observer: SessionObserver<FakeRecords>): Promise<(number | null)[]> => {
      const bus = new EventBus();
      const seen: (number | null)[] = [];
      bus.on('rateLimits.updated', (limits) => {
        seen.push(...(limits.windows ?? []).map((window) => window.usedPct));
      });
      const watcher = make(observer, bus, aDayLater);
      await watcher.start();
      expect(watcher.sessionIds()).toStrictEqual([]);
      return seen;
    };
    expect(await used({ ...codexObserver(root), reportsLimits: true })).toStrictEqual([50]);
    expect(await used(codexObserver(root))).toStrictEqual([]);
  });

  it('sends the newest rate limits from any rollout and never an older one after them', async () => {
    const day = path.join(root, '2026', '10', '16');
    await mkdir(day, { recursive: true });
    const older = path.join(
      day,
      'rollout-2026-10-16T22-06-42-019a0000-6060-7000-8000-000000000002.jsonl',
    );
    const newer = path.join(
      day,
      'rollout-2026-10-16T22-07-10-019a0000-6060-7000-8000-000000000003.jsonl',
    );
    await writeFile(older, lines([{ type: 'limit', at: 100, used: 10 }]));
    await writeFile(newer, lines([{ type: 'limit', at: 200, used: 50 }]));
    const bus = new EventBus();
    const used: (number | null)[] = [];
    bus.on('rateLimits.updated', (limits) => {
      used.push(...(limits.windows ?? []).map((window) => window.usedPct));
    });
    const watcher = make(codexObserver(root), bus);
    await watcher.start();
    expect(used.at(-1)).toBe(50);
    expect(used.slice(used.indexOf(50))).toStrictEqual([50]);
    await appendFile(older, lines([{ type: 'limit', at: 150, used: 20 }, { type: 'reply' }]));
    await watcher.refresh();
    expect(used.at(-1)).toBe(50);
    await appendFile(older, lines([{ type: 'limit', at: 300, used: 70 }]));
    await watcher.refresh();
    expect(used.at(-1)).toBe(70);
  });
});
