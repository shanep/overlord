import { appendFile, mkdir, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventName } from '../bus.js';
import { EventBus } from '../bus.js';

import type { SessionLayout } from './test-helpers/fixtures.js';
import {
  assistant,
  attachment,
  jsonl,
  makeSessionLayout,
  makeTemporaryDirectory,
  removeDir,
  SESSION,
  sidechain,
  system,
  T0,
  text,
  toolResult,
  toolUse,
  usage,
  userPrompt,
  writeSubagent,
} from './test-helpers/fixtures.js';
import type { WatchFactory, WatchHandle } from './watcher.js';
import {
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_POLL_INTERVAL_MS,
  defaultWatchFactory,
  TranscriptWatcher,
} from './watcher.js';

const NAMES: readonly EventName[] = [
  'session.upserted',
  'agent.upserted',
  'tool.upserted',
  'request.recorded',
  'feed.appended',
  'context.updated',
  'compaction.recorded',
  'source.error',
];

interface Captured {
  readonly name: EventName;
  readonly payload: unknown;
}

function capture(bus: EventBus): Captured[] {
  const events: Captured[] = [];
  for (const name of NAMES) {
    bus.on(name, (payload) => {
      events.push({ name, payload });
    });
  }
  return events;
}

function names(events: readonly Captured[]): EventName[] {
  return events.map((event) => event.name);
}

function payloads(events: readonly Captured[], name: EventName): unknown[] {
  return events.filter((event) => event.name === name).map((event) => event.payload);
}

const YEAR = 365 * 24 * 60 * 60 * 1000;

describe('TranscriptWatcher', () => {
  let root = '';
  let layout: SessionLayout;
  let bus: EventBus;
  let events: Captured[];
  let clock = T0;
  const watchers: TranscriptWatcher[] = [];

  function make(
    overrides: Partial<ConstructorParameters<typeof TranscriptWatcher>[0]> = {},
  ): TranscriptWatcher {
    const watcher = new TranscriptWatcher({
      projectsDir: layout.projectsDir,
      bus,
      activeWindowMs: 10 * YEAR,
      now: (): number => clock,
      watchFactory: null,
      accumulator: { runningWindowMs: 60_000 },
      ...overrides,
    });
    watchers.push(watcher);
    return watcher;
  }

  beforeEach(async () => {
    root = await makeTemporaryDirectory();
    layout = await makeSessionLayout(root);
    bus = new EventBus();
    events = capture(bus);
    clock = T0 + 1000;
  });

  afterEach(async () => {
    for (const watcher of watchers.splice(0)) {
      watcher.dispose();
    }
    vi.useRealTimers();
    await removeDir(root);
  });

  it('publishes everything in a new session in a fixed order', async () => {
    await writeFile(
      layout.transcriptPath,
      jsonl([
        userPrompt('u1', 0, 'start'),
        attachment('c1', 1, { type: 'prompt_snapshot', systemPrompt: ['sys'] }),
        assistant({
          uuid: 'a1',
          at: 2,
          messageId: 'm1',
          stop: 'tool_use',
          usage: usage({ input: 5 }),
          content: [toolUse('toolu_1', 'Agent')],
        }),
        assistant({
          uuid: 'a2',
          at: 3,
          messageId: 'm1',
          stop: 'tool_use',
          usage: usage({ input: 9 }),
          content: [],
        }),
        system('s1', 4, { subtype: 'compact_boundary', content: 'Compacted' }),
      ]),
    );
    await writeSubagent(layout, {
      agentId: 'x1',
      meta: {
        agentType: 'Explore',
        description: 'look',
        toolUseId: 'toolu_1',
        spawnDepth: 1,
        requestShape: 'foreground',
      },
      records: [
        sidechain('x1', attachment('c2', 5, { type: 'agent_listing_delta', addedTypes: ['Plan'] })),
      ],
    });
    const watcher = make();
    await watcher.refresh();

    expect(names(events)).toStrictEqual([
      'session.upserted',
      'agent.upserted',
      'agent.upserted',
      'tool.upserted',
      'request.recorded',
      'feed.appended',
      'context.updated',
      'context.updated',
      'compaction.recorded',
    ]);
    expect(payloads(events, 'session.upserted')[0]).toMatchObject({
      id: SESSION,
      state: 'running',
      agentCount: 1,
    });
    expect(payloads(events, 'agent.upserted')).toMatchObject([
      { id: SESSION, agentType: 'main' },
      { id: 'x1', parentAgentId: SESSION, agentType: 'Explore' },
    ]);
    expect(payloads(events, 'tool.upserted')).toMatchObject([
      { id: 'toolu_1', name: 'Agent', endedAt: null },
    ]);
    expect(payloads(events, 'request.recorded')).toMatchObject([
      { messageId: 'm1', usage: { input: 9 } },
    ]);
    expect(payloads(events, 'feed.appended')).toMatchObject([
      {
        sessionId: SESSION,
        agentId: SESSION,
        items: [{ kind: 'user' }, { kind: 'tool_use' }, { kind: 'system' }],
      },
    ]);
    expect(payloads(events, 'context.updated')).toMatchObject([
      { agentId: SESSION, systemPrompt: ['sys'] },
      { agentId: 'x1', agentTypes: ['Plan'] },
    ]);
    expect(payloads(events, 'compaction.recorded')).toStrictEqual([
      { sessionId: SESSION, agentId: SESSION, at: T0 + 4 },
    ]);
    expect(watcher.sessionIds()).toStrictEqual([SESSION]);
    expect(watcher.session(SESSION)?.feed('x1')).toStrictEqual([]);
    expect(watcher.session('nope')).toBeUndefined();
  });

  it('publishes nothing when nothing changed, then only what was appended', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'start')]));
    const watcher = make();
    await watcher.refresh();
    events.length = 0;
    await watcher.refresh();
    expect(events).toStrictEqual([]);

    await appendFile(
      layout.transcriptPath,
      jsonl([
        assistant({
          uuid: 'a1',
          at: 10,
          messageId: 'm1',
          stop: 'tool_use',
          content: [toolUse('t1', 'Bash')],
        }),
        toolResult('u2', 20, [{ toolUseId: 't1', text: 'fine' }]),
      ]),
    );
    await watcher.refresh();
    expect(names(events)).toStrictEqual([
      'session.upserted',
      'agent.upserted',
      'tool.upserted',
      'request.recorded',
      'feed.appended',
    ]);
    expect(payloads(events, 'tool.upserted')).toMatchObject([
      { id: 't1', ok: true, endedAt: T0 + 20 },
    ]);
    expect(payloads(events, 'feed.appended')).toMatchObject([
      { items: [{ kind: 'tool_use' }, { kind: 'tool_result' }] },
    ]);
  });

  it('publishes state changes that come only from time passing', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'start')]));
    const watcher = make();
    await watcher.refresh();
    expect(payloads(events, 'session.upserted')).toMatchObject([{ state: 'running' }]);
    events.length = 0;
    clock = T0 + 120_000;
    await watcher.refresh();
    expect(names(events)).toStrictEqual(['session.upserted', 'agent.upserted']);
    expect(payloads(events, 'session.upserted')).toMatchObject([{ state: 'idle' }]);
  });

  it('starts the session over when the transcript is truncated', async () => {
    await writeFile(
      layout.transcriptPath,
      jsonl([userPrompt('u1', 0, 'first'), userPrompt('u2', 1, 'second')]),
    );
    const watcher = make();
    await watcher.refresh();
    const before = watcher.session(SESSION);
    await truncate(layout.transcriptPath, 0);
    await appendFile(layout.transcriptPath, jsonl([userPrompt('u3', 2, 'fresh')]));
    events.length = 0;
    await watcher.refresh();
    const after = watcher.session(SESSION);
    expect(after).not.toBe(before);
    expect(after?.feed(SESSION).map((item) => item.id)).toStrictEqual(['u3']);
    expect(names(events)).toStrictEqual(['session.upserted', 'agent.upserted', 'feed.appended']);
  });

  it('starts over when a subagent transcript is truncated', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'main')]));
    const subPath = await writeSubagent(layout, {
      agentId: 'x1',
      meta: { agentType: 'Plan' },
      records: [
        sidechain('x1', userPrompt('s1', 1, 'one')),
        sidechain('x1', userPrompt('s2', 2, 'two')),
      ],
    });
    const watcher = make();
    await watcher.refresh();
    await writeFile(subPath, jsonl([sidechain('x1', userPrompt('s3', 3, 'three'))]));
    await watcher.refresh();
    expect(
      watcher
        .session(SESSION)
        ?.feed('x1')
        .map((item) => item.id),
    ).toStrictEqual(['s3']);
    expect(
      watcher
        .session(SESSION)
        ?.feed(SESSION)
        .map((item) => item.id),
    ).toStrictEqual(['u1']);
  });

  it('ignores inactive sessions and drops sessions that go quiet', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'old')]));
    const old = new Date(Date.now() - 2 * YEAR);
    await utimes(layout.transcriptPath, old, old);
    const watcher = make({ activeWindowMs: YEAR });
    await watcher.refresh();
    expect(events).toStrictEqual([]);
    expect(watcher.sessionIds()).toStrictEqual([]);

    const now = new Date();
    await utimes(layout.transcriptPath, now, now);
    clock = Date.now();
    await watcher.refresh();
    expect(watcher.sessionIds()).toStrictEqual([SESSION]);
    events.length = 0;

    await utimes(layout.transcriptPath, old, old);
    await watcher.refresh();
    expect(watcher.sessionIds()).toStrictEqual([]);
    expect(events).toStrictEqual([]);
  });

  it('publishes the last state of a session as it goes quiet', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'x')]));
    const watcher = make({ activeWindowMs: YEAR });
    await watcher.refresh();
    expect(payloads(events, 'session.upserted')).toMatchObject([{ state: 'running' }]);
    events.length = 0;
    const old = new Date(clock - 2 * YEAR);
    await utimes(layout.transcriptPath, old, old);
    clock = T0 + 120_000;
    await watcher.refresh();
    expect(names(events)).toStrictEqual(['session.upserted', 'agent.upserted']);
    expect(payloads(events, 'session.upserted')).toMatchObject([{ state: 'idle' }]);
    expect(watcher.sessionIds()).toStrictEqual([]);
  });

  it('picks up a meta file written after the transcript', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'x')]));
    await writeSubagent(layout, {
      agentId: 'x1',
      meta: null,
      records: [sidechain('x1', userPrompt('s1', 1, 'y'))],
    });
    const watcher = make();
    await watcher.refresh();
    expect(payloads(events, 'agent.upserted')).toMatchObject([
      { id: SESSION },
      { id: 'x1', agentType: 'unknown' },
    ]);
    events.length = 0;
    await writeFile(
      path.join(layout.subagentsDir, 'agent-x1.meta.json'),
      JSON.stringify({ agentType: 'Explore' }),
    );
    await watcher.refresh();
    expect(payloads(events, 'agent.upserted')).toMatchObject([{ id: 'x1', agentType: 'Explore' }]);
    events.length = 0;
    await writeFile(
      path.join(layout.subagentsDir, 'agent-x1.meta.json'),
      JSON.stringify({ agentType: 'Changed' }),
    );
    await watcher.refresh();
    expect(events).toStrictEqual([]);
  });

  it('adds subagents that appear later', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'x')]));
    const watcher = make();
    await watcher.refresh();
    events.length = 0;
    await writeSubagent(layout, {
      agentId: 'x2',
      meta: { agentType: 'Plan' },
      records: [
        sidechain('x2', assistant({ uuid: 's', at: 5, messageId: 'mm', content: [text('hi')] })),
      ],
    });
    await watcher.refresh();
    expect(names(events)).toStrictEqual([
      'session.upserted',
      'agent.upserted',
      'request.recorded',
      'feed.appended',
    ]);
    expect(payloads(events, 'feed.appended')).toMatchObject([
      { agentId: 'x2', items: [{ kind: 'text', text: 'hi' }] },
    ]);
  });

  it('reports read errors and keeps going', async () => {
    const dir = path.join(root, 'real-dir');
    await mkdir(dir);
    await writeFile(path.join(dir, 'inner.txt'), 'x');
    await symlink(dir, path.join(layout.projectDir, 'broken.jsonl'));
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'x')]));
    const watcher = make();
    await watcher.refresh();
    expect(payloads(events, 'source.error')).toMatchObject([{ source: 'transcripts' }]);
    const [error] = payloads(events, 'source.error');
    expect(JSON.stringify(error)).toMatch(/EISDIR/u);
    expect(watcher.sessionIds()).toContain(SESSION);
  });

  it('runs one follow-up cycle for refreshes requested mid-cycle', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'x')]));
    const watcher = make();
    const first = watcher.refresh();
    await appendFile(layout.transcriptPath, jsonl([userPrompt('u2', 1, 'y')]));
    const second = watcher.refresh();
    const third = watcher.refresh();
    await Promise.all([first, second, third]);
    expect(
      watcher
        .session(SESSION)
        ?.feed(SESSION)
        .map((item) => item.id),
    ).toStrictEqual(['u1', 'u2']);
    events.length = 0;
    await watcher.refresh();
    expect(events).toStrictEqual([]);
  });

  it('stops publishing once disposed, even mid-cycle', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'x')]));
    const watcher = make();
    const running = watcher.refresh();
    watcher.dispose();
    await running;
    await watcher.refresh();
    expect(events).toStrictEqual([]);
    await watcher.start();
    expect(events).toStrictEqual([]);
  });

  it('stops after the current session when disposed between sessions', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'x')]));
    const second = path.join(layout.projectDir, 'sess-0002.jsonl');
    await writeFile(second, jsonl([userPrompt('v1', 0, 'y')]));
    const watcher = make();
    bus.on('session.upserted', () => {
      watcher.dispose();
    });
    await watcher.refresh();
    expect(names(events)).toStrictEqual(['session.upserted']);
    expect(payloads(events, 'session.upserted')).toHaveLength(1);
    expect(watcher.sessionIds()).toHaveLength(1);
  });

  it('polls on a timer that it clears on dispose', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'x')]));
    const watcher = make({ pollIntervalMs: 50 });
    await watcher.start();
    expect(vi.getTimerCount()).toBe(1);
    await watcher.start();
    expect(vi.getTimerCount()).toBe(1);
    await appendFile(layout.transcriptPath, jsonl([userPrompt('u2', 1, 'y')]));
    vi.advanceTimersByTime(49);
    await watcher.refresh();
    events.length = 0;
    await appendFile(layout.transcriptPath, jsonl([userPrompt('u3', 2, 'z')]));
    vi.advanceTimersByTime(50);
    await watcher.refresh();
    expect(
      watcher
        .session(SESSION)
        ?.feed(SESSION)
        .map((item) => item.id),
    ).toStrictEqual(['u1', 'u2', 'u3']);
    watcher.dispose();
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the default poll interval and window', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(2000);
    expect(DEFAULT_ACTIVE_WINDOW_MS).toBe(30 * 60 * 1000);
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'x')]));
    const watcher = new TranscriptWatcher({
      projectsDir: layout.projectsDir,
      bus,
      watchFactory: null,
    });
    watchers.push(watcher);
    await watcher.start();
    expect(watcher.sessionIds()).toStrictEqual([SESSION]);
    expect(vi.getTimerCount()).toBe(1);
    const old = new Date(Date.now() - DEFAULT_ACTIVE_WINDOW_MS - 60_000);
    await utimes(layout.transcriptPath, old, old);
    await watcher.refresh();
    expect(watcher.sessionIds()).toStrictEqual([]);
    vi.advanceTimersByTime(1999);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('refreshes when the watch factory reports a change and handles watch errors', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'x')]));
    const changes: (() => void)[] = [];
    const failures: ((error: unknown) => void)[] = [];
    const closed: string[] = [];
    const factory: WatchFactory = (dir, change, fail): WatchHandle => {
      closed.push(`open:${dir}`);
      changes.push(change);
      failures.push(fail);
      return {
        close: (): void => {
          closed.push('close');
        },
      };
    };
    const watcher = make({ watchFactory: factory });
    await watcher.start();
    expect(closed).toStrictEqual([`open:${layout.projectsDir}`]);
    await appendFile(layout.transcriptPath, jsonl([userPrompt('u2', 1, 'y')]));
    changes[0]?.();
    await watcher.refresh();
    expect(watcher.session(SESSION)?.feed(SESSION)).toHaveLength(2);
    failures[0]?.(new Error('watch broke'));
    expect(closed).toStrictEqual([`open:${layout.projectsDir}`, 'close']);
    expect(payloads(events, 'source.error')).toStrictEqual([
      { source: 'transcripts', message: 'watch broke' },
    ]);
    failures[0]?.('again');
    watcher.dispose();
    expect(closed).toHaveLength(2);
    expect(payloads(events, 'source.error')).toStrictEqual([
      { source: 'transcripts', message: 'watch broke' },
      { source: 'transcripts', message: 'again' },
    ]);
  });

  it('closes the watch on dispose and stays quiet about later watch errors', async () => {
    const closed: string[] = [];
    const failures: ((error: unknown) => void)[] = [];
    const watcher = make({
      watchFactory: (_dir, _change, fail): WatchHandle => {
        failures.push(fail);
        return {
          close: (): void => {
            closed.push('close');
          },
        };
      },
    });
    await watcher.start();
    watcher.dispose();
    expect(closed).toStrictEqual(['close']);
    failures[0]?.(new Error('late'));
    expect(payloads(events, 'source.error')).toStrictEqual([]);
  });

  it('reports a watch factory that throws and falls back to polling', async () => {
    const watcher = make({
      watchFactory: (): WatchHandle => {
        throw new Error('no recursive watch');
      },
    });
    await watcher.start();
    expect(payloads(events, 'source.error')).toStrictEqual([
      { source: 'transcripts', message: 'no recursive watch' },
    ]);
  });

  it('uses fs.watch by default and reports a missing projects dir', async () => {
    const watcher = new TranscriptWatcher({
      projectsDir: path.join(root, 'missing'),
      bus,
      pollIntervalMs: 60_000,
    });
    watchers.push(watcher);
    await watcher.start();
    expect(payloads(events, 'source.error')).toMatchObject([{ source: 'transcripts' }]);
  });
});

describe('TranscriptWatcher.open', () => {
  let root = '';
  let layout: SessionLayout;
  const watchers: TranscriptWatcher[] = [];

  beforeEach(async () => {
    root = await makeTemporaryDirectory();
    layout = await makeSessionLayout(root);
  });

  afterEach(async () => {
    for (const watcher of watchers.splice(0)) {
      watcher.dispose();
    }
    await removeDir(root);
  });

  it('loads an old session outside the active window and keeps tailing it', async () => {
    await writeFile(layout.transcriptPath, jsonl([userPrompt('u1', 0, 'old work')]));
    const old = new Date(T0 - YEAR);
    await utimes(layout.transcriptPath, old, old);
    const bus = new EventBus();
    const events = capture(bus);
    const watcher = new TranscriptWatcher({
      projectsDir: layout.projectsDir,
      bus,
      activeWindowMs: 60_000,
      now: (): number => T0,
      watchFactory: null,
    });
    watchers.push(watcher);
    await watcher.refresh();
    expect(events).toStrictEqual([]);
    expect(await watcher.open(SESSION)).toBe(true);
    expect(watcher.sessionIds()).toStrictEqual([SESSION]);
    expect(payloads(events, 'session.upserted')).toMatchObject([
      { id: SESSION, cwd: '/work/demo' },
    ]);
    await appendFile(layout.transcriptPath, jsonl([userPrompt('u2', 1, 'more')]));
    await utimes(layout.transcriptPath, old, old);
    await watcher.refresh();
    expect(watcher.sessionIds()).toStrictEqual([SESSION]);
    expect(payloads(events, 'feed.appended').length).toBeGreaterThanOrEqual(2);
  });

  it('returns false and does not pin a session that has no transcript', async () => {
    const watcher = new TranscriptWatcher({
      projectsDir: layout.projectsDir,
      bus: new EventBus(),
      watchFactory: null,
    });
    watchers.push(watcher);
    expect(await watcher.open('missing')).toBe(false);
    expect(watcher.sessionIds()).toStrictEqual([]);
  });
});

describe('defaultWatchFactory', () => {
  let root = '';

  beforeEach(async () => {
    root = await makeTemporaryDirectory();
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it('reports changes in nested folders until closed', async () => {
    const nested = path.join(root, 'project');
    await mkdir(nested);
    const errors: unknown[] = [];
    const handles: WatchHandle[] = [];
    const state = { seen: false };
    const changed = new Promise<void>((resolve) => {
      const handle = defaultWatchFactory(
        root,
        () => {
          state.seen = true;
          resolve();
        },
        (error) => {
          errors.push(error);
        },
      );
      handles.push(handle);
    });
    // macOS can miss a write made right after the watch starts, so keep
    // writing until the watcher reports one.
    for (let attempt = 0; attempt < 40 && !state.seen; attempt += 1) {
      await writeFile(path.join(nested, 'session.jsonl'), `${String(attempt)}\n`);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    await changed;
    expect(handles).toHaveLength(1);
    handles[0]?.close();
    expect(errors).toStrictEqual([]);
  });
});
