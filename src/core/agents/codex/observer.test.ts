// cspell:words rollouts
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventName, OverlordEvents } from '../../bus.js';
import { EventBus } from '../../bus.js';
import { makeTemporaryDirectory, removeDir } from '../../transcripts/test-helpers/fixtures.js';
import { TailingWatcher } from '../shared/tailing-watcher.js';

import { codexHome, codexObserver, peekRollout, rolloutId, scanRollouts } from './observer.js';

const ROLLOUTS = fileURLToPath(
  new URL('../../../../test/fixtures/codex/0.163.0/rollouts/', import.meta.url),
);
const EDIT = '01a1480a-d128-7ff0-b026-896f6f880226';
const EDIT_FILE = `rollout-2026-10-16T22-07-10-${EDIT}.jsonl`;
const PLAIN = '01a1480a-6060-7fc1-8932-a87d32a8bac6';
const PLAIN_FILE = `rollout-2026-10-16T22-06-42-${PLAIN}.jsonl`;

function capture(bus: EventBus): { name: EventName; payload: unknown }[] {
  const seen: { name: EventName; payload: unknown }[] = [];
  const names: EventName[] = [
    'session.upserted',
    'agent.upserted',
    'request.recorded',
    'feed.appended',
    'rateLimits.updated',
    'source.error',
  ];
  for (const name of names) {
    bus.on(name, (payload: OverlordEvents[typeof name]) => {
      seen.push({ name, payload });
    });
  }
  return seen;
}

function byText(left: string, right: string): number {
  return left.localeCompare(right);
}

describe('codex observer', () => {
  let home = '';
  let codex = '';
  let day = '';

  beforeEach(async () => {
    home = await makeTemporaryDirectory();
    codex = path.join(home, 'codex-home');
    day = path.join(codex, 'sessions', '2026', '10', '16');
    await mkdir(day, { recursive: true });
  });

  afterEach(async () => {
    await removeDir(home);
  });

  it('finds Codex home from CODEX_HOME, else ~/.codex', () => {
    expect(codexHome({ home: '/h', env: { CODEX_HOME: '/x/codex' } })).toBe('/x/codex');
    expect(codexHome({ home: '/h', env: { CODEX_HOME: ' ' } })).toBe(path.join('/h', '.codex'));
    expect(codexHome({ home: '/h', env: {} })).toBe(path.join('/h', '.codex'));
  });

  it('takes the thread id from a rollout file name', () => {
    expect(rolloutId(EDIT_FILE)).toBe(EDIT);
    expect(rolloutId('notes.txt')).toBeNull();
    expect(rolloutId('rollout-2026.jsonl')).toBeNull();
  });

  it('scans dated folders newest first and treats a missing folder as no sessions', async () => {
    await copyFile(path.join(ROLLOUTS, PLAIN_FILE), path.join(day, PLAIN_FILE));
    await copyFile(path.join(ROLLOUTS, EDIT_FILE), path.join(day, EDIT_FILE));
    await writeFile(path.join(day, 'notes.txt'), 'not a rollout');
    const found = await scanRollouts(path.join(codex, 'sessions'));
    expect(found.map((info) => info.sessionId).toSorted(byText)).toStrictEqual(
      [PLAIN, EDIT].toSorted(byText),
    );
    expect(await scanRollouts(path.join(home, 'nowhere'))).toStrictEqual([]);
    expect(codexObserver({ home, env: {} }).watchRoot).toBeNull();
  });

  it('peeks the folder, branch and first prompt for the all-sessions list', async () => {
    await copyFile(path.join(ROLLOUTS, EDIT_FILE), path.join(day, EDIT_FILE));
    const [info] = await scanRollouts(path.join(codex, 'sessions'));
    expect(info).toBeDefined();
    if (info === undefined) {
      return;
    }
    expect(await peekRollout(info)).toStrictEqual({
      cwd: '/work/repo',
      gitBranch: 'master',
      title:
        'Append the line world to notes.txt by editing the file (use apply_patch). Then reply done.',
    });
    const observer = codexObserver({ home, env: { CODEX_HOME: codex } });
    const rows = await observer.list?.({
      known: new Map(),
      peek: async (session, read) => read(session),
      report: vi.fn(),
    });
    expect(rows).toMatchObject([
      { id: EDIT, agent: 'codex', cwd: '/work/repo', handoffs: ['resume-local'] },
    ]);
  });

  it('tails a rollout from a temp CODEX_HOME into the bus, each call once', async () => {
    const text = await readFile(path.join(ROLLOUTS, EDIT_FILE), 'utf8');
    const lines = text.split('\n');
    const file = path.join(day, EDIT_FILE);
    // Half the file first, so the session is mid-turn, then the rest.
    await writeFile(file, `${lines.slice(0, 15).join('\n')}\n`);
    const bus = new EventBus();
    const events = capture(bus);
    const toolNames: string[] = [];
    bus.on('tool.upserted', (tool) => {
      toolNames.push(tool.name);
    });
    const watcher = new TailingWatcher({
      observer: codexObserver({ home, env: { CODEX_HOME: codex } }),
      bus,
      now: (): number => Date.now(),
      watchFactory: null,
    });
    try {
      await watcher.start();
      expect(watcher.sessionIds()).toStrictEqual([EDIT]);
      expect(watcher.busy(EDIT)).toBe(true);
      await writeFile(file, text);
      await watcher.refresh();
      expect(watcher.busy(EDIT)).toBe(false);
    } finally {
      watcher.dispose();
    }
    const requests = events.filter((event) => event.name === 'request.recorded');
    expect(requests).toHaveLength(3);
    expect(toolNames).toStrictEqual(['exec_command', 'apply_patch']);
    expect(events.filter((event) => event.name === 'source.error')).toStrictEqual([]);
    expect(events.findLast((event) => event.name === 'session.upserted')?.payload).toMatchObject({
      id: EDIT,
      agent: 'codex',
      title: 'Append the line world to notes.txt by editing the file (use apply_patch). Then r...',
    });
    // The plan limits go to the Usage view and the Fleet header, like Claude Code's.
    expect(events.findLast((event) => event.name === 'rateLimits.updated')?.payload).toMatchObject({
      windows: [
        { agent: 'codex', id: 'primary', label: '30 day', usedPct: 0, resetsAt: 1_794_802_006_000 },
      ],
    });
  });
});
