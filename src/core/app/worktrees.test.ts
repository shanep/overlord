import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { fakeQueries, resultMessage } from '../../../test/fake-claude/fake-query.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { LaunchProfile } from '../../shared/model.js';
import type { BackendEndpoint } from '../bridge/backend.js';
import { BOISESTATE_PROFILE, BRIDGE_BASE_URL } from '../bridge/boisestate.js';
import { transcriptPathFor } from '../surfaces/desktop.js';
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
  BACKEND_TITLE,
  BRIDGE_ID,
  CLAUDE_ID,
  HERE_ID,
  PROFILE_PICK,
} from './actions-open-project.js';
import { AS_IS, UPDATE } from './resume.js';
import {
  makeApp,
  makeEnv,
  type TestApp,
  type TestEnv,
  waitFor,
  writeJson,
} from './test-helpers/fixtures.js';
import { startSession, tidyWorktrees, worktreeRoot } from './worktrees.js';

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
      // Polls for a background session return at once instead of sleeping.
      delay: async (): Promise<void> => {
        await Promise.resolve();
      },
    },
    queries: fakeQueries((query) => {
      query.emit(resultMessage());
    }),
  });
  onTestFinished(async () => {
    // A new session's setup goes on in the background and writes into its
    // worktree, so the temp folders can only go once it is done.
    await test.app.runtime.worktrees.setupsDone();
    await waitFor(() => !test.app.runtime.caches.worktrees.loading);
  });
  return test;
}

/** Starts a session with the New Session command, in this window's folder. */
async function newSession(test: TestApp): Promise<void> {
  test.env.host.pickAnswers.push(HERE_ID);
  await test.app.dispatch({ type: 'newSession' }, {});
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
  await newSession(test);
  const terminal = lastTerminal(test);
  await edit(terminal.cwd);
  await test.app.sessionClosed(terminal.sessionId ?? '');
  const id = test.app.runtime.caches.worktrees.value.at(-1)?.id;
  await summaries(test);
  return id ?? terminal.sessionId ?? '';
}

/** A Claude Code session that worked in cwd and has ended, as the session registry lists it. */
async function endedSession(test: TestApp, cwd: string): Promise<void> {
  const entry = { pid: 999, sessionId: 'old', cwd, name: 'Old work' };
  await writeJson(path.join(test.env.paths.sessionsDir, '999.json'), entry);
}

async function continueOld(test: TestApp, answer: string | null): Promise<void> {
  test.env.host.askAnswers.push(answer);
  await test.app.dispatch({ type: 'handoff', sessionId: 'old', kind: 'resume-local' }, {});
}

/** The folder of a session's worktree after its tab closed with nothing left, which removes it. */
async function tidiedAway(test: TestApp): Promise<string> {
  await newSession(test);
  const terminal = lastTerminal(test);
  await test.app.sessionClosed(terminal.sessionId ?? '');
  expect(existsSync(terminal.cwd)).toBe(false);
  return terminal.cwd;
}

async function landUpstream(): Promise<void> {
  await commitFile(world.other, 'b.txt', 'two\n');
  await git(world.other, 'push', '-q', 'origin', 'main');
}

/** An app where Boise State is set up, and its bridge answers with a loopback URL and token. */
async function bridged(
  starts: (readonly string[])[] = [],
  profile: LaunchProfile = BOISESTATE_PROFILE,
): Promise<TestApp> {
  const test = await setup('repo', async (_command, args) => {
    starts.push(args);
    await Promise.resolve();
    return { code: 1, stdout: '', stderr: 'claude does not run in tests' };
  });
  test.env.host.backendEndpoint = async (): Promise<BackendEndpoint> => {
    await Promise.resolve();
    return { baseUrl: 'http://127.0.0.1:9', token: 'tok' };
  };
  await test.app.dispatch({ type: 'saveProfile', profile }, {});
  return test;
}

/** The bridge's endpoint is down, for the reason a missing key gives. */
async function noKey(): Promise<BackendEndpoint> {
  await Promise.resolve();
  throw new Error('No Boise State API key is set.');
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
      await newSession(test);
      const terminal = lastTerminal(test);
      expect(terminal).toMatchObject({ args: ['attach', '8c3efb13'], sessionId: '8c3efb13-full' });
      expect(terminal.cwd.startsWith(worktreeRoot(test.env.paths))).toBe(true);
      expect(started[0]?.slice(0, 2)).toStrictEqual(['--bg', '--settings']);
      const settings: unknown = JSON.parse(started[0]?.[2] ?? '{}');
      expect(settings).toMatchObject({ env: { OVERLORD_SLOT: '0' } });
      const [worktree] = await summaries(test);
      expect(test.app.runtime.sessionWorktrees.get('8c3efb13-full')).toBe(worktree?.id);
    });

    it('stop when their tab closes with nothing left to do, and take the worktree along', async () => {
      const calls: (readonly string[])[] = [];
      const test = await setup('repo', async (_command, args) => {
        await Promise.resolve();
        calls.push(args);
        if (args.includes('--bg')) {
          return { code: 0, stdout: 'backgrounded · 8c3efb13 (idle)\n', stderr: '' };
        }
        const listed = [
          {
            id: '8c3efb13',
            pid: 777,
            sessionId: '8c3efb13-full',
            kind: 'background',
            status: 'idle',
            state: 'done',
          },
        ];
        return { code: 0, stdout: JSON.stringify(listed), stderr: '' };
      });
      await newSession(test);
      const terminal = lastTerminal(test);
      await test.app.sessionClosed('8c3efb13-full');
      expect(calls).toContainEqual(['stop', '8c3efb13']);
      expect(existsSync(terminal.cwd)).toBe(false);
    });

    it('open no tab, and say so, when the background session never shows up', async () => {
      // An attach tab would exit at once ("No job matching") and vanish, so none opens.
      const test = await setup('repo', async (_command, args) => {
        await Promise.resolve();
        const stdout = args.includes('--bg') ? 'backgrounded \u00B7 8c3efb13 (idle)\n' : '[]';
        return { code: 0, stdout, stderr: '' };
      });
      await newSession(test);
      expect(test.env.host.terminals).toStrictEqual([]);
      expect(test.env.host.warnings.at(-1)).toContain('did not become ready');
      expect(test.app.runtime.sessionWorktrees.size).toBe(0);
    });

    it('open in their own worktree and go away once closed with nothing left', async () => {
      const test = await setup();
      await newSession(test);
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
      await newSession(plain);
      expect(lastTerminal(plain)).toMatchObject({ cwd: plain.env.host.workspace });
      expect(lastTerminal(plain).env).toBeUndefined();
      expect(plain.env.host.warnings).toStrictEqual([]);
      const none = await setup('none');
      await newSession(none);
      expect(lastTerminal(none)).toMatchObject({ cwd: none.env.home });
    });

    it('fall back to the folder with a warning when the worktree cannot be made', async () => {
      const test = await setup();
      await writeFile(path.join(test.env.home, '.overlord'), 'in the way');
      await newSession(test);
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
      await newSession(test);
      await waitFor(() => test.env.host.warnings.length > 0);
      expect(test.env.host.warnings).toHaveLength(1);
      expect(test.env.host.warnings[0]).toMatch(
        /^Running \.overlord\/setup\.sh failed: \.overlord\/setup\.sh exited 2/u,
      );
    });

    it('open the tab while setup runs, and wait for it before removing the worktree', async () => {
      await mkdir(path.join(world.other, '.overlord'));
      await commitFile(
        world.other,
        SETUP_SCRIPT,
        'while [ ! -f go ]; do sleep 0.02; done\necho done > set-up.txt\n',
      );
      await git(world.other, 'push', '-q', 'origin', 'main');
      const test = await setup();
      await newSession(test);
      const terminal = lastTerminal(test);
      expect(existsSync(path.join(terminal.cwd, 'set-up.txt'))).toBe(false);
      const closed = test.app.sessionClosed(terminal.sessionId ?? '');
      await writeFile(path.join(terminal.cwd, 'go'), '');
      await closed;
      expect(existsSync(terminal.cwd)).toBe(true);
      expect(await readFile(path.join(terminal.cwd, 'set-up.txt'), 'utf8')).toBe('done\n');
    });

    it('wait for setup before a session that starts working on its first prompt', async () => {
      await mkdir(path.join(world.other, '.overlord'));
      await commitFile(world.other, SETUP_SCRIPT, 'sleep 0.2\necho done > set-up.txt\n');
      await git(world.other, 'push', '-q', 'origin', 'main');
      const test = await setup();
      await startSession(test.app.runtime, world.repo, { name: 'Combined', prompt: 'Read this' });
      const terminal = lastTerminal(test);
      expect(terminal).toMatchObject({ name: 'Combined' });
      expect(terminal.args.at(-1)).toBe('Read this');
      expect(await readFile(path.join(terminal.cwd, 'set-up.txt'), 'utf8')).toBe('done\n');
    });

    it('report a release that fails', async () => {
      const test = await setup();
      await newSession(test);
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
      await newSession(test);
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

    it('keep a released worktree while the daemon restarts the job in it', async () => {
      const test = await setup();
      await newSession(test);
      const terminal = lastTerminal(test);
      await writeJson(path.join(test.env.paths.configDir, 'daemon', 'roster.json'), {
        supervisorPid: PID,
        workers: { '2c087de9': { pid: 999_999, attempt: 2, cwd: terminal.cwd } },
      });
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
      // A busy machine can make the background worktree reload fail too, so
      // look for the setup warning alone instead of counting every error.
      const warnings = errors.filter((error) => error.message.includes(SETUP_SCRIPT));
      expect(warnings.map((error) => error.source)).toStrictEqual(['worktrees']);
      expect(warnings[0]?.message).toMatch(
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
      // A tidy ends with this refresh. Waiting for it keeps the tidy from
      // writing into the storage folder after the test removes it.
      const { worktrees } = test.app.runtime.caches;
      const refresh = worktrees.refresh.bind(worktrees);
      const tidies: Promise<void>[] = [];
      vi.spyOn(worktrees, 'refresh').mockImplementation(async () => {
        const done = refresh();
        tidies.push(done);
        return done;
      });
      await test.app.start();
      await waitFor(() => tidies.length === 1);
      await Promise.all(tidies);
      const timer = test.intervals.find((entry) => entry.ms === 60_000);
      expect(timer).toBeDefined();
      timer?.callback();
      await waitFor(() => tidies.length === 2);
      await Promise.all(tidies);
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
      await newSession(test);
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

  describe('continued sessions', () => {
    const PREFIX = '"Old work" may be missing Overlord features.';

    it('get their tidied-away worktree back at the same path', async () => {
      const test = await setup();
      const folder = await tidiedAway(test);
      await endedSession(test, folder);
      await continueOld(test, AS_IS);
      expect(test.env.host.asks.at(-1)).toStrictEqual({
        message: `${PREFIX} Its worktree was removed once its work landed, so Overlord made it again from the latest main, and files it remembers may have changed.`,
        actions: [UPDATE, AS_IS],
      });
      expect(lastTerminal(test)).toMatchObject({
        cwd: folder,
        args: ['--resume', 'old'],
        sessionId: 'old',
        env: { OVERLORD_SLOT: '0' },
      });
      expect(existsSync(path.join(folder, 'a.txt'))).toBe(true);
      expect(await summaries(test)).toMatchObject([{ state: 'active', path: folder }]);
      await test.app.sessionClosed('old');
      expect(existsSync(folder)).toBe(false);
    });

    it('look at the code again first when brought up to date', async () => {
      const test = await setup();
      const folder = await tidiedAway(test);
      await endedSession(test, folder);
      await continueOld(test, UPDATE);
      const terminal = lastTerminal(test);
      expect(terminal.args.slice(0, 2)).toStrictEqual(['--resume', 'old']);
      expect(terminal.args[2]).toContain(
        'Overlord brought this session up to date before you continue:\n- Its worktree was removed',
      );
      expect(terminal.args[2]).toContain('git status and git log');
    });

    it('let go of the worktree again when the warning is dismissed', async () => {
      const test = await setup();
      const folder = await tidiedAway(test);
      await endedSession(test, folder);
      const before = test.env.host.terminals.length;
      await continueOld(test, null);
      expect(test.env.host.terminals).toHaveLength(before);
      expect(existsSync(folder)).toBe(false);
      expect(test.app.runtime.sessionWorktrees.size).toBe(0);
    });

    it('move out of the shared checkout into a worktree of their own, leaving the original', async () => {
      const test = await setup();
      await endedSession(test, world.repo);
      await continueOld(test, AS_IS);
      expect(test.env.host.asks.at(-1)?.message).toBe(
        `${PREFIX} It works in ${world.repo} itself, not its own worktree, so other sessions can change its files and it has no port slot.`,
      );
      expect(lastTerminal(test)).toMatchObject({ cwd: world.repo, args: ['--resume', 'old'] });
      expect(lastTerminal(test).env).toBeUndefined();

      await continueOld(test, UPDATE);
      const terminal = lastTerminal(test);
      expect(terminal.cwd.startsWith(worktreeRoot(test.env.paths))).toBe(true);
      expect(terminal.args.slice(0, 4)).toStrictEqual([
        '--resume',
        'old',
        '--fork-session',
        '--session-id',
      ]);
      expect(terminal.args.at(-1)).toContain(`The original stays in ${world.repo}`);
    });

    it('rebase a branch that fell behind, and say when it cannot', async () => {
      const test = await setup();
      const id = await finishedSession(test, async (worktree) =>
        commitFile(worktree, 'c.txt', 'mine\n'),
      );
      await summaries(test);
      const kept = test.app.runtime.caches.worktrees.value.find((row) => row.id === id);
      const folder = { path: kept?.path ?? '' };
      await landUpstream();
      await endedSession(test, folder.path);
      await continueOld(test, UPDATE);
      expect(test.env.host.asks.at(-1)?.message).toBe(
        `${PREFIX} Its branch is 1 commit behind origin/main.`,
      );
      expect(existsSync(path.join(folder.path, 'b.txt'))).toBe(true);
      const terminal = lastTerminal(test);
      expect(terminal).toMatchObject({ cwd: folder.path, env: { OVERLORD_SLOT: '0' } });
      expect(terminal.args[2]).toContain(
        "Rebased this worktree's branch onto the latest origin/main, which had 1 new commit.",
      );
      await test.app.sessionClosed('old');

      await writeFile(path.join(folder.path, 'c.txt'), 'edited\n');
      await commitFile(world.other, 'd.txt', 'three\n');
      await git(world.other, 'push', '-q', 'origin', 'main');
      await continueOld(test, UPDATE);
      expect(test.env.host.warnings.at(-1)).toBe(
        'Overlord could not update the branch: The worktree has uncommitted changes. Commit or discard them first.',
      );
      expect(lastTerminal(test).args[2]).toContain('and could not:');
    });

    it('go back to Boise State when that is where they ran', async () => {
      const test = await bridged();
      const plain = path.join(world.dir, 'plain');
      await mkdir(plain);
      await endedSession(test, plain);
      const transcript = transcriptPathFor(test.env.paths, plain, 'old');
      await mkdir(path.dirname(transcript), { recursive: true });
      const reply = { type: 'assistant', message: { model: 'global.anthropic.claude-opus-5-5' } };
      await writeFile(transcript, `${JSON.stringify(reply)}\n`);
      await continueOld(test, null);
      expect(lastTerminal(test)).toMatchObject({
        cwd: plain,
        args: [
          '--model',
          'claude-opus-5-5',
          '--strict-mcp-config',
          '--permission-mode',
          'default',
          '--resume',
          'old',
        ],
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'tok' },
      });

      const before = test.env.host.terminals.length;
      test.env.host.backendEndpoint = noKey;
      await continueOld(test, null);
      expect(test.env.host.terminals).toHaveLength(before);
      expect(test.env.host.warnings.at(-1)).toBe('No Boise State API key is set.');
    });

    it('say nothing when there is nothing missing', async () => {
      const test = await setup();
      const plain = path.join(world.dir, 'plain');
      await mkdir(plain);
      await endedSession(test, plain);
      await continueOld(test, null);
      expect(test.env.host.asks).toStrictEqual([]);
      expect(lastTerminal(test)).toMatchObject({ cwd: plain, args: ['--resume', 'old'] });
    });
  });

  describe('Boise State sessions', () => {
    it('are a choice on the sparkle once Boise State is set up', async () => {
      const starts: (readonly string[])[] = [];
      const test = await bridged(starts);
      test.env.host.pickAnswers.push(HERE_ID, BRIDGE_ID);
      await test.app.dispatch({ type: 'newSession' }, {});
      expect(test.env.host.picks.at(-1)?.placeholder).toBe(BACKEND_TITLE);
      const terminal = lastTerminal(test);
      expect(terminal).toMatchObject({
        name: 'Boise State',
        args: [
          '--model',
          'claude-opus-5-5',
          '--strict-mcp-config',
          '--permission-mode',
          'default',
          '--session-id',
          terminal.sessionId,
        ],
        env: {
          OVERLORD_SLOT: '0',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
          ANTHROPIC_AUTH_TOKEN: 'tok',
        },
      });
      expect(terminal.env?.['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(terminal.cwd.startsWith(worktreeRoot(test.env.paths))).toBe(true);
      // The sidecar goes away with the window, so claude runs in the tab, not in the background.
      expect(starts).toStrictEqual([]);
      await test.app.sessionClosed(terminal.sessionId ?? '');
      expect(existsSync(terminal.cwd)).toBe(false);
    });

    it('are offered for a profile saved with only the old placeholder', async () => {
      const old: LaunchProfile = {
        id: 'old',
        name: 'Boise State from before',
        agent: CLAUDE_CODE,
        model: BOISESTATE_PROFILE.model,
        effort: null,
        permissionMode: null,
        env: { ANTHROPIC_BASE_URL: BRIDGE_BASE_URL },
        extraArgs: [],
      };
      const test = await bridged([], old);
      test.env.host.pickAnswers.push(HERE_ID, BRIDGE_ID);
      await test.app.dispatch({ type: 'newSession' }, {});
      expect(lastTerminal(test)).toMatchObject({
        name: 'Boise State',
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'tok' },
      });
      await test.app.sessionClosed(lastTerminal(test).sessionId ?? '');
    });

    it('leave the usual session as it was, and start nothing when the choice is cancelled', async () => {
      const test = await bridged();
      test.env.host.pickAnswers.push(HERE_ID, CLAUDE_ID);
      await test.app.dispatch({ type: 'newSession' }, {});
      expect(lastTerminal(test)).toMatchObject({ name: 'Claude Code' });
      expect(lastTerminal(test).env?.['ANTHROPIC_BASE_URL']).toBeUndefined();
      await test.app.sessionClosed(lastTerminal(test).sessionId ?? '');

      const before = test.env.host.terminals.length;
      test.env.host.pickAnswers.push(HERE_ID, null);
      await test.app.dispatch({ type: 'newSession' }, {});
      expect(test.env.host.terminals).toHaveLength(before);
      expect(await summaries(test)).toStrictEqual([]);
    });

    it('are not offered before Boise State is set up', async () => {
      const test = await setup();
      test.env.host.backendEndpoint = async (): Promise<BackendEndpoint> => {
        await Promise.resolve();
        return { baseUrl: 'http://127.0.0.1:9', token: 'tok' };
      };
      await newSession(test);
      expect(test.env.host.picks.map((pick) => pick.placeholder)).not.toContain(BACKEND_TITLE);
      await test.app.sessionClosed(lastTerminal(test).sessionId ?? '');
    });

    it('start from their own command, and make no worktree when the bridge cannot start', async () => {
      const test = await bridged();
      test.env.host.pickAnswers.push(HERE_ID);
      await test.app.dispatch({ type: 'newBridgeChat' }, {});
      expect(lastTerminal(test).name).toBe('Boise State');
      await test.app.sessionClosed(lastTerminal(test).sessionId ?? '');

      const before = test.env.host.terminals.length;
      test.env.host.backendEndpoint = noKey;
      test.env.host.pickAnswers.push(HERE_ID);
      await test.app.dispatch({ type: 'newBridgeChat' }, {});
      expect(test.env.host.warnings.at(-1)).toBe('No Boise State API key is set.');
      expect(test.env.host.terminals).toHaveLength(before);
      expect(await summaries(test)).toStrictEqual([]);
    });
  });

  describe('sessions from a launch profile', () => {
    const OPUS: LaunchProfile = {
      id: 'opus-plan',
      name: 'Opus planning',
      agent: CLAUDE_CODE,
      model: 'opus',
      effort: 'high',
      permissionMode: 'plan',
      env: {},
      extraArgs: [],
    };

    async function withProfile(
      profile: LaunchProfile,
      starts: (readonly string[])[] = [],
    ): Promise<TestApp> {
      const test = await setup('repo', async (_command, args) => {
        starts.push(args);
        await Promise.resolve();
        return { code: 1, stdout: '', stderr: 'claude does not run in tests' };
      });
      await test.app.dispatch({ type: 'saveProfile', profile }, {});
      return test;
    }

    it('start on its model, effort and mode, in the background start and the tab alike', async () => {
      const starts: (readonly string[])[] = [];
      const test = await withProfile(OPUS, starts);
      test.env.host.pickAnswers.push(HERE_ID, `${PROFILE_PICK}${OPUS.id}`);
      await test.app.dispatch({ type: 'newSession' }, {});
      expect(test.env.host.picks.at(-1)).toMatchObject({ placeholder: BACKEND_TITLE });
      expect(test.env.host.picks.at(-1)?.items.at(-1)).toStrictEqual({
        id: `${PROFILE_PICK}${OPUS.id}`,
        label: 'Opus planning',
        description: 'opus, high effort, plan',
      });
      const flags = ['--model', 'opus', '--effort', 'high', '--permission-mode', 'plan'];
      expect(starts[0]?.slice(0, 7)).toStrictEqual([...flags, '--bg']);
      const terminal = lastTerminal(test);
      expect(terminal.args).toStrictEqual([...flags, '--session-id', terminal.sessionId]);
      await test.app.sessionClosed(terminal.sessionId ?? '');
    });

    it('leave the command as it was on the usual account, and are not offered when they set none of the three', async () => {
      const test = await withProfile(OPUS);
      test.env.host.pickAnswers.push(HERE_ID, CLAUDE_ID);
      await test.app.dispatch({ type: 'newSession' }, {});
      const terminal = lastTerminal(test);
      expect(terminal.args).toStrictEqual(['--session-id', terminal.sessionId]);
      await test.app.sessionClosed(terminal.sessionId ?? '');

      const plain = await withProfile({
        ...OPUS,
        id: 'env-only',
        model: null,
        effort: null,
        permissionMode: null,
        env: { FOO: '1' },
      });
      await newSession(plain);
      expect(plain.env.host.picks.map((pick) => pick.placeholder)).not.toContain(BACKEND_TITLE);
      expect(lastTerminal(plain).args).toStrictEqual([
        '--session-id',
        lastTerminal(plain).sessionId,
      ]);
      await plain.app.sessionClosed(lastTerminal(plain).sessionId ?? '');
    });
  });
});
