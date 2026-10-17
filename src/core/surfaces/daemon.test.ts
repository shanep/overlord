import { describe, expect, it } from 'vitest';

import { daemonJobCwds } from './daemon.js';
import { makeScratchHome } from './test-helpers/scratch-home.js';

const ROSTER = '.claude/daemon/roster.json';

describe('daemonJobCwds', () => {
  it('returns nothing when the daemon has no roster', async () => {
    const home = await makeScratchHome();
    await expect(daemonJobCwds(home.paths, () => true)).resolves.toStrictEqual([]);
    await home.cleanup();
  });

  it('lists the folder of every job the daemon supervises', async () => {
    const home = await makeScratchHome();
    await home.writeJson(ROSTER, {
      proto: 1,
      supervisorPid: 35_684,
      workers: {
        '2c087de9': { pid: 1770, attempt: 2, cwd: '/wt/a', sessionId: 's-a' },
        '426d696a': { pid: 33_214, attempt: 1, cwd: '/wt/b', sessionId: 's-b' },
        '8e336324': { pid: 1793, sessionId: 's-c' },
      },
    });
    await expect(daemonJobCwds(home.paths, (pid) => pid === 35_684)).resolves.toStrictEqual([
      '/wt/a',
      '/wt/b',
    ]);
    await home.cleanup();
  });

  it('ignores the roster once its daemon is gone', async () => {
    const home = await makeScratchHome();
    await home.writeJson(ROSTER, { supervisorPid: 35_684, workers: { a: { cwd: '/wt/a' } } });
    await expect(daemonJobCwds(home.paths, () => false)).resolves.toStrictEqual([]);
    await home.cleanup();
  });

  it('throws on a roster it cannot read', async () => {
    const home = await makeScratchHome();
    await home.writeJson(ROSTER, { workers: [] });
    await expect(daemonJobCwds(home.paths, () => true)).rejects.toThrow(/unexpected shape/u);
    await home.cleanup();
  });
});
