import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { fakeQueries, resultMessage } from '../../../test/fake-claude/fake-query.js';
import type { Exec } from '../sync/exec.js';
import { SETUP_SCRIPT } from '../worktrees/setup.js';
import {
  commitFile,
  git,
  type GitWorld,
  makeWorld,
  testExec,
} from '../worktrees/test-helpers/git-world.js';

import {
  makeApp,
  makeEnv,
  type TestApp,
  type TestEnv,
  waitFor,
  writeJson,
} from './test-helpers/fixtures.js';
import { tidyWorktrees, worktreeRoot } from './worktrees.js';

const PID = 4242;

/** Stands in for claude. By default a background start fails, so tabs run claude themselves. */
const noClaude: Exec = async () => {
  await Promise.resolve();
  return { code: 1, stdout: '', stderr: 'claude does not run in tests' };
};

let world: GitWorld;

async function setup(
  workspace: 'repo' | 'plain' | 'none' = 'repo',
  claude: Exec = noClaude,
): Promise<TestApp> {
  const env: TestEnv = await makeEnv({ workspace: workspace === 'plain' });
  if (workspace === 'repo') {
    env.host.workspace = world.repo;
  }
  const test = makeApp(env, {
    deps: {
      // Real git for the worktrees, but never the real claude.
      exec: async (command, args, options) =>
        command === 'claude' ? claude(command, args, options) : testExec(command, args, options),
      isAlive: (pid) => pid === PID,
      pid: PID,
    },
    queries: fakeQueries((query) => {
      query.emit(resultMessage());
    }),
  });
  onTestFinished(async () => {
    await waitFor(() => !test.app.runtime.caches.worktrees.loading);
  });
  return test;
}

function lastTerminal(test: TestApp): TestEnv['host']['terminals'][number] {
  const terminal = test.env.host.terminals.at(-1);
  if (terminal === undefined) {
    throw new Error('No terminal opened');
  }
  return terminal;
}

interface SourceError {
  readonly source: string;
  readonly message: string;
}

function captureErrors(test: TestApp): SourceError[] {
  const errors: SourceError[] = [];
  test.bus.on('source.error', (payload) => errors.push(payload));
  return errors;
}

/** Makes a folder read-only until the test ends, so writes into it fail. */
async function readOnly(folder: string): Promise<void> {
  await chmod(folder, 0o500);
  onTestFinished(async () => {
    await chmod(folder, 0o700);
  });
}

async function summaries(test: TestApp): Promise<readonly { id: string; state: string }[]> {
  await test.app.runtime.caches.worktrees.refresh();
  return test.app.runtime.caches.worktrees.value;
}

/** Starts a session, runs edit in its worktree, then closes its tab. */
async function finishedSession(
  test: TestApp,
  edit: (worktree: string) => Promise<unknown>,
): Promise<string> {
  await test.app.dispatch({ type: 'newSession' }, {});
  const terminal = lastTerminal(test);
  await edit(terminal.cwd);
  await test.app.sessionClosed(terminal.sessionId ?? '');
  const id = test.app.runtime.caches.worktrees.value.at(-1)?.id;
  await summaries(test);
  return id ?? terminal.sessionId ?? '';
}

// Each test runs real git many times, which takes far longer than usual on a busy machine.
describe('worktrees in the app', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    const made = await makeWorld();
    world = made;
    // Finish hooks run newest first, so this one runs after each app has
    // stopped and its last background git command has finished.
    onTestFinished(async () => {
      await rm(made.dir, { recursive: true, force: true, maxRetries: 5 });
    });
  });

  describe('new sessions', () => {
    it('run in the background in their worktree, with its variables as settings', async () => {
      const started: (readonly string[])[] = [];
      const test = await setup('repo', async (_command, args) => {
        await Promise.resolve();
        if (args.includes('--bg')) {
          started.push(args);
          return { code: 0, stdout: 'backgrounded \u00B7 8c3efb13 (idle)\n', stderr: '' };
        }
        const listed = [{ id: '8c3efb13', sessionId: '8c3efb13-full', kind: 'background' }];
        return { code: 0, stdout: JSON.stringify(listed), stderr: '' };
      });
      await test.app.dispatch({ type: 'newSession' }, {});
      const terminal = lastTerminal(test);
      expect(terminal).toMatchObject({ args: ['attach', '8c3efb13'], sessionId: '8c3efb13-full' });
      expect(terminal.cwd.startsWith(worktreeRoot(test.env.paths))).toBe(true);
      expect(started[0]?.slice(0, 2)).toStrictEqual(['--bg', '--settings']);
      const settings: unknown = JSON.parse(started[0]?.[2] ?? '{}');
      expect(settings).toMatchObject({ env: { OVERLORD_SLOT: '0' } });
      const [worktree] = await summaries(test);
      expect(test.app.runtime.sessionWorktrees.get('8c3efb13-full')).toBe(worktree?.id);
    });

    it('open the tab even when Claude Code does not list the background session yet', async () => {
      const test = await setup('repo', async (_command, args) => {
        await Promise.resolve();
        const stdout = args.includes('--bg') ? 'backgrounded \u00B7 8c3efb13 (idle)\n' : '[]';
        return { code: 0, stdout, stderr: '' };
      });
      await test.app.dispatch({ type: 'newSession' }, {});
      expect(lastTerminal(test)).toMatchObject({ args: ['attach', '8c3efb13'], sessionId: null });
      expect(test.app.runtime.sessionWorktrees.size).toBe(0);
    });

    it('open in their own worktree and go away once closed with nothing left', async () => {
      const test = await setup();
      await test.app.dispatch({ type: 'newSession' }, {});
      const terminal = lastTerminal(test);
      expect(terminal).toMatchObject({
        name: 'Claude Code',
        command: 'claude',
        args: ['--session-id', terminal.sessionId],
        env: { OVERLORD_SLOT: '0' },
      });
      expect(terminal.cwd.startsWith(worktreeRoot(test.env.paths))).toBe(true);
      expect(await summaries(test)).toMatchObject([
        { id: terminal.sessionId, kind: 'session', label: 'Session in repo', state: 'active' },
      ]);
      await test.app.sessionClosed(terminal.sessionId ?? '');
      expect(existsSync(terminal.cwd)).toBe(false);
      expect(test.app.runtime.caches.worktrees.value).toStrictEqual([]);
      await test.app.sessionClosed(terminal.sessionId ?? '');
    });

    it('open in the folder itself outside git, or in home with no folder', async () => {
      const plain = await setup('plain');
      await plain.app.dispatch({ type: 'newSession' }, {});
      expect(lastTerminal(plain)).toMatchObject({ cwd: plain.env.host.workspace });
      expect(lastTerminal(plain).env).toBeUndefined();
      expect(plain.env.host.warnings).toStrictEqual([]);
      const none = await setup('none');
      await none.app.dispatch({ type: 'newSession' }, {});
      expect(lastTerminal(none)).toMatchObject({ cwd: none.env.home });
    });

    it('fall back to the folder with a warning when the worktree cannot be made', async () => {
      const test = await setup();
      await writeFile(path.join(test.env.home, '.overlord'), 'in the way');
      await test.app.dispatch({ type: 'newSession' }, {});
      expect(lastTerminal(test)).toMatchObject({ cwd: world.repo });
      expect(test.env.host.warnings).toHaveLength(1);
      expect(test.env.host.warnings[0]).toMatch(
        /^Starting without a worktree: git worktree failed/u,
      );
    });

    it('show setup warnings', async () => {
      await mkdir(path.join(world.other, '.overlord'));
      await commitFile(world.other, SETUP_SCRIPT, 'exit 2\n');
      await git(world.other, 'push', '-q', 'origin', 'main');
      const test = await setup();
      await test.app.dispatch({ type: 'newSession' }, {});
      expect(test.env.host.warnings).toHaveLength(1);
      expect(test.env.host.warnings[0]).toMatch(
        /^Running \.overlord\/setup\.sh failed: \.overlord\/setup\.sh exited 2/u,
      );
    });

    it('report a release that fails', async () => {
      const test = await setup();
      await test.app.dispatch({ type: 'newSession' }, {});
      const errors = captureErrors(test);
      await readOnly(path.join(test.env.storageDir, 'worktrees'));
      await test.app.sessionClosed(lastTerminal(test).sessionId ?? '');
      expect(errors.map((error) => error.source)).toStrictEqual(['worktrees']);
      expect(errors[0]?.message).toMatch(/EACCES/u);
    });
  });

  describe('live sessions', () => {
    it('keep a released worktree while a Claude process still works in it', async () => {
      const test = await setup();
      await test.app.dispatch({ type: 'newSession' }, {});
      const terminal = lastTerminal(test);
      const sessions = test.env.paths.sessionsDir;
      await writeJson(path.join(sessions, '1.json'), {
        pid: PID,
        sessionId: 'resumed',
        cwd: terminal.cwd,
      });
      await writeJson(path.join(sessions, '2.json'), { pid: PID, sessionId: 'nowhere' });
      await test.app.sessionClosed(terminal.sessionId ?? '');
      expect(existsSync(terminal.cwd)).toBe(true);
      expect(await summaries(test)).toMatchObject([{ state: 'active' }]);
    });
  });

  describe('launched runs', () => {
    it('work in a worktree that goes away when the run ends clean', async () => {
      const test = await setup();
      await test.app.dispatch(
        {
          type: 'launch',
          specs: [
            {
              prompt: 'hi',
              cwd: world.repo,
              profileId: null,
              worktree: true,
              maxBudgetUsd: null,
              label: 'Run A',
            },
          ],
        },
        {},
      );
      await test.app.runtime.launcher.idle();
      const [run] = test.app.runtime.launcher.runs();
      expect(run?.state).toBe('done');
      expect(run?.worktreePath?.startsWith(worktreeRoot(test.env.paths))).toBe(true);
      expect(test.queries.queries[0]?.options.env).toMatchObject({ OVERLORD_SLOT: '0' });
      expect(existsSync(run?.worktreePath ?? '')).toBe(false);
    });

    it('work in the folder itself outside git, and fail when git breaks', async () => {
      const test = await setup();
      const launch = async (cwd: string): Promise<void> => {
        await test.app.dispatch(
          {
            type: 'launch',
            specs: [
              {
                prompt: 'hi',
                cwd,
                profileId: null,
                worktree: true,
                maxBudgetUsd: null,
                label: cwd,
              },
            ],
          },
          {},
        );
        await test.app.runtime.launcher.idle();
      };
      await launch(world.dir);
      expect(test.app.runtime.launcher.runs()[0]).toMatchObject({
        state: 'done',
        worktreePath: null,
      });
      await writeFile(path.join(test.env.home, '.overlord'), 'in the way');
      await launch(world.repo);
      const failed = test.app.runtime.launcher.runs()[1];
      expect(failed?.state).toBe('failed');
      expect(failed?.result).toMatch(/^git worktree failed/u);
    });

    it('report setup warnings', async () => {
      await mkdir(path.join(world.other, '.overlord'));
      await commitFile(world.other, SETUP_SCRIPT, 'exit 5\n');
      await git(world.other, 'push', '-q', 'origin', 'main');
      const test = await setup();
      const errors = captureErrors(test);
      await test.app.dispatch(
        {
          type: 'launch',
          specs: [
            {
              prompt: 'hi',
              cwd: world.repo,
              profileId: null,
              worktree: true,
              maxBudgetUsd: null,
              label: 'A',
            },
          ],
        },
        {},
      );
      await test.app.runtime.launcher.idle();
      expect(errors.map((error) => error.source)).toStrictEqual(['worktrees']);
      expect(errors[0]?.message).toMatch(
        /^Running \.overlord\/setup\.sh failed: \.overlord\/setup\.sh exited 5/u,
      );
    });
  });

  describe('tidyWorktrees', () => {
    it('reloads the list and reports a reconcile that fails', async () => {
      const test = await setup();
      await finishedSession(test, async (worktree) =>
        writeFile(path.join(worktree, 'a.txt'), 'edited\n'),
      );
      const errors = captureErrors(test);
      await tidyWorktrees(test.app.runtime);
      expect(test.app.runtime.caches.worktrees.value).toMatchObject([{ state: 'dirty' }]);
      expect(errors).toStrictEqual([]);
      await rm(lastTerminal(test).cwd, { recursive: true, force: true });
      await readOnly(path.join(test.env.storageDir, 'worktrees'));
      await tidyWorktrees(test.app.runtime);
      expect(errors.map((error) => error.source)).toStrictEqual(['worktrees']);
      expect(errors[0]?.message).toMatch(/EACCES/u);
      expect(test.app.runtime.caches.worktrees.value).toMatchObject([{ state: 'missing' }]);
    });

    it('runs on start and on a timer', async () => {
      const test = await setup();
      await test.app.start();
      await waitFor(() => !test.app.runtime.caches.worktrees.loading);
      const timer = test.intervals.find((entry) => entry.ms === 60_000);
      expect(timer).toBeDefined();
      timer?.callback();
      await waitFor(() => !test.app.runtime.caches.worktrees.loading);
    });
  });

  describe('worktree actions', () => {
    it('land unlanded work and say so', async () => {
      const test = await setup();
      const id = await finishedSession(test, async (worktree) =>
        commitFile(worktree, 'mine.txt', 'mine\n'),
      );
      expect(await summaries(test)).toMatchObject([{ id, state: 'unlanded' }]);
      await test.app.dispatch({ type: 'landWorktree', id }, {});
      expect(test.env.host.infos).toContain('Landed Session in repo.');
      expect(await git(world.origin, 'ls-tree', '--name-only', 'main')).toContain('mine.txt');
      expect(test.app.runtime.caches.worktrees.value).toStrictEqual([]);
    });

    it('warn on a conflict and show other failures as errors', async () => {
      const test = await setup();
      const id = await finishedSession(test, async (worktree) =>
        commitFile(worktree, 'a.txt', 'mine\n'),
      );
      await commitFile(world.other, 'a.txt', 'theirs\n');
      await git(world.other, 'push', '-q', 'origin', 'main');
      await test.app.dispatch({ type: 'landWorktree', id }, {});
      expect(test.env.host.warnings).toStrictEqual([
        'The rebase onto the latest default branch conflicts in a.txt. Open a session in it to resolve the conflict.',
      ]);
      await test.app.dispatch({ type: 'landWorktree', id: 'nope' }, {});
      expect(test.env.host.errors).toStrictEqual(['Overlord has no worktree nope.']);
    });

    it('discard only after the user confirms, naming what goes', async () => {
      const test = await setup();
      const id = await finishedSession(test, async (worktree) => {
        await commitFile(worktree, 'mine.txt', 'mine\n');
        await writeFile(path.join(worktree, 'a.txt'), 'edited\n');
      });
      await test.app.dispatch({ type: 'discardWorktree', id }, {});
      expect(test.env.host.questions).toStrictEqual([
        {
          message:
            'Discard Session in repo? This deletes 1 uncommitted file and 1 unlanded commit.',
          action: 'Discard',
        },
      ]);
      expect(await summaries(test)).toHaveLength(1);
      test.env.host.confirmAnswers.push(true);
      await test.app.dispatch({ type: 'discardWorktree', id }, {});
      expect(await summaries(test)).toStrictEqual([]);
      test.env.host.confirmAnswers.push(true);
      await test.app.dispatch({ type: 'discardWorktree', id: 'gone' }, {});
      expect(test.env.host.questions.at(-1)?.message).toBe(
        'Discard this worktree? This deletes everything in it.',
      );
      expect(test.env.host.errors).toStrictEqual(['Overlord has no worktree gone.']);
    });

    it('describe a worktree with nothing in it as losing nothing', async () => {
      const test = await setup();
      await test.app.dispatch({ type: 'newSession' }, {});
      const id = lastTerminal(test).sessionId ?? '';
      await summaries(test);
      await test.app.dispatch({ type: 'discardWorktree', id }, {});
      expect(test.env.host.questions.at(-1)?.message).toBe(
        'Discard Session in repo? This deletes nothing.',
      );
    });

    it('open a new session in a kept worktree', async () => {
      const test = await setup();
      const id = await finishedSession(test, async (worktree) =>
        writeFile(path.join(worktree, 'a.txt'), 'edited\n'),
      );
      const before = test.env.host.terminals.length;
      await test.app.dispatch({ type: 'openWorktree', id }, {});
      expect(test.env.host.terminals).toHaveLength(before + 1);
      const terminal = lastTerminal(test);
      expect(terminal.sessionId).not.toBe(id);
      expect(await summaries(test)).toMatchObject([{ id, state: 'active', path: terminal.cwd }]);
      await test.app.sessionClosed(terminal.sessionId ?? '');
      expect(await summaries(test)).toMatchObject([{ id, state: 'dirty' }]);
    });
  });
});
