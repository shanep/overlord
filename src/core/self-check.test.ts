import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { runSelfCheck, selfCheckPath, writeSelfCheck } from './self-check.js';

describe('runSelfCheck', () => {
  it('builds every view twice, measures the second time and keeps errors from the run', async () => {
    let now = 100;
    const builds: string[] = [];
    let settled = false;
    const report = await runSelfCheck({
      views: ['fleet', 'tuning'],
      build: (view) => {
        builds.push(view);
        now += 7;
        if (view === 'tuning' && settled) {
          throw new Error('bad transcript');
        }
        return { view, rows: [1, 2] };
      },
      settle: async () => {
        await Promise.resolve();
        settled = true;
        now += 1000;
      },
      errors: () => [
        { source: 'old', message: 'before the check', at: 50 },
        { source: 'usage', message: 'stats-cache.json is malformed', at: 900 },
      ],
      clock: () => now,
    });
    expect(builds).toStrictEqual(['fleet', 'tuning', 'fleet', 'tuning']);
    expect(report.views).toStrictEqual([
      {
        view: 'fleet',
        ok: true,
        ms: 7,
        bytes: JSON.stringify({ view: 'fleet', rows: [1, 2] }).length,
        error: null,
      },
      { view: 'tuning', ok: false, ms: 7, bytes: 0, error: 'bad transcript' },
    ]);
    expect(report.errors).toStrictEqual([
      { source: 'usage', message: 'stats-cache.json is malformed' },
    ]);
    expect(report.at).toBe(now);
  });

  it('records a thrown non-error as text', async () => {
    const report = await runSelfCheck({
      views: ['help'],
      build: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the check must survive it
        throw 'plain';
      },
      settle: async () => {
        await Promise.resolve();
      },
      errors: () => [],
      clock: () => 0,
    });
    expect(report.views[0]?.error).toBe('plain');
  });

  it('writes the report where the install script looks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'overlord-check-'));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const file = selfCheckPath({ home: root });
    expect(file).toBe(path.join(root, '.overlord', 'check.json'));
    const report = { bundleMtimeMs: 5, at: 6, views: [], errors: [] };
    await writeSelfCheck(file, report);
    expect(JSON.parse(await readFile(file, 'utf8'))).toStrictEqual(report);
  });
});
