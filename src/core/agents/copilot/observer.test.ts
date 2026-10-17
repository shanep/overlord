import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COPILOT } from '../../../shared/agents.js';
import type { SessionSummary } from '../../../shared/model.js';
import type { OverlordEvents } from '../../bus.js';
import { EventBus } from '../../bus.js';
import { resolveClaudePaths } from '../../paths.js';
import { makeTemporaryDirectory, removeDir } from '../../transcripts/test-helpers/fixtures.js';
import { TailingWatcher } from '../shared/tailing-watcher.js';

import { copilotHome, copilotObserver, scanCopilotSessions } from './observer.js';

import { copilot } from './index.js';

const STATE_DIR = fileURLToPath(
  new URL('../../../../test/fixtures/copilot/1.0.89/session-state/', import.meta.url),
);
const EDIT = '11111111-1111-4111-8111-000000000003';
const DENIED = '11111111-1111-4111-8111-000000000004';

describe('copilotHome', () => {
  it('uses COPILOT_HOME when set and ~/.copilot otherwise', () => {
    expect(copilotHome({ home: '/home/user', env: { COPILOT_HOME: '/data/copilot' } })).toBe(
      '/data/copilot',
    );
    expect(copilotHome({ home: '/home/user', env: { COPILOT_HOME: ' ' } })).toBe(
      path.join('/home/user', '.copilot'),
    );
    expect(copilotHome({ home: '/home/user', env: {} })).toBe(path.join('/home/user', '.copilot'));
  });
});

describe('copilotObserver', () => {
  let home: string;

  beforeEach(async () => {
    home = await makeTemporaryDirectory();
  });

  afterEach(async () => {
    await removeDir(home);
  });

  async function copySession(sessionId: string): Promise<string> {
    const target = path.join(home, 'session-state', sessionId);
    await cp(path.join(STATE_DIR, sessionId), target, { recursive: true });
    return target;
  }

  it('finds nothing and watches nothing before Copilot makes its folder', async () => {
    const observer = copilotObserver(home);
    expect(observer.watchRoot).toBeNull();
    expect(await observer.scan()).toStrictEqual([]);
    expect(await scanCopilotSessions(path.join(home, 'none'))).toStrictEqual([]);
  });

  it('scans session folders with an events file, newest first', async () => {
    await copySession(EDIT);
    await copySession(DENIED);
    await mkdir(path.join(home, 'session-state', 'empty'));
    await writeFile(path.join(home, 'session-state', 'stray.txt'), '');
    const observer = copilotObserver(home);
    expect(observer.watchRoot).toBe(path.join(home, 'session-state'));
    const sessions = await observer.scan();
    expect(
      sessions
        .map((session) => session.sessionId)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual([EDIT, DENIED]);
    const [newest] = sessions;
    expect(newest?.transcriptPath).toMatch(/events\.jsonl$/u);
    expect(
      await Promise.all(sessions.map(async (session) => observer.childFiles(session))),
    ).toStrictEqual([[], []]);
  });

  it('lists sessions from workspace.yaml with only the handoffs Copilot has', async () => {
    await copySession(EDIT);
    const observer = copilotObserver(home);
    const reports: string[] = [];
    const rows = await observer.list?.({
      known: new Map(),
      peek: async (session, read) => read(session),
      report: (message) => {
        reports.push(message);
      },
    });
    expect(reports).toStrictEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({
      id: EDIT,
      agent: COPILOT,
      surface: 'cli',
      cwd: '/work/repo',
      handoffs: ['resume-local'],
    });
    expect(rows?.[0]?.title).toContain('In calc.py add the one-line docstring');
  });

  it('feeds a Copilot session from a temp COPILOT_HOME into the bus', async () => {
    await copySession(EDIT);
    const observer = copilot.observer?.create({
      home: '/nowhere',
      env: { COPILOT_HOME: home },
      claude: resolveClaudePaths({ home, platform: 'linux', env: {} }),
    });
    expect(observer?.source).toBe('copilot');
    const bus = new EventBus();
    const sessions: SessionSummary[] = [];
    const tools: OverlordEvents['tool.upserted'][] = [];
    const requests: OverlordEvents['request.recorded'][] = [];
    const feeds: OverlordEvents['feed.appended'][] = [];
    bus.on('session.upserted', (summary) => sessions.push(summary));
    bus.on('tool.upserted', (tool) => tools.push(tool));
    bus.on('request.recorded', (request) => requests.push(request));
    bus.on('feed.appended', (feed) => feeds.push(feed));
    if (observer === undefined) {
      throw new Error('the Copilot adapter has an observer');
    }
    const watcher = new TailingWatcher({ observer, bus, watchFactory: null });
    try {
      await watcher.start();
      expect(watcher.sessionIds()).toStrictEqual([EDIT]);
      expect(sessions.at(-1)).toMatchObject({
        id: EDIT,
        agent: COPILOT,
        state: 'done',
        model: 'gpt-5-mini',
        usage: { input: 792, output: 654, cacheRead: 36_096 },
      });
      expect(tools.map((tool) => tool.name)).toStrictEqual(['view', 'edit']);
      expect(requests).toHaveLength(3);
      expect(feeds[0]?.agentId).toBe(EDIT);
      expect(feeds[0]?.items[0]).toMatchObject({ kind: 'user' });
    } finally {
      watcher.dispose();
    }
  });
});
