import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { LaunchSpec } from '../../shared/model.js';
import type { Exec, ExecResult } from '../sync/exec.js';
import { makeWorld, testExec } from '../worktrees/test-helpers/git-world.js';

import { IN_LAUNCHER } from './actions-session.js';
import { STOP_LABEL } from './relocate.js';
import {
  makeApp,
  makeEnv,
  ok,
  session,
  type TestApp,
  type TestEnv,
  waitFor,
  writeJson,
} from './test-helpers/fixtures.js';
import { worktreeRoot } from './worktrees.js';

const JOB_PID = 5150;
const TERMINAL_PID = 123;

interface Claude {
  /** Answers each claude call, or undefined for a failure. */
  readonly answer?: (args: readonly string[]) => ExecResult | undefined;
  /** The pids that are alive. */
  readonly alive?: (pid: number) => boolean;
}

interface Relocating {
  readonly test: TestApp;
  readonly env: TestEnv;
  /** Args of every claude call. */
  readonly calls: (readonly string[])[];
  /** A folder outside git to move into. */
  readonly plain: string;
}

const FAILED: ExecResult = { code: 1, stdout: '', stderr: 'claude does not run in tests' };

async function relocating(claude: Claude = {}): Promise<Relocating> {
  const env = await makeEnv();
  const plain = path.join(env.root, 'plain');
  await mkdir(plain, { recursive: true });
  const calls: (readonly string[])[] = [];
  const exec: Exec = async (command, args, options) => {
    if (command !== 'claude') {
      return testExec(command, args, options);
    }
    calls.push(args);
    await Promise.resolve();
    return claude.answer?.(args) ?? FAILED;
  };
  const test = makeApp(env, {
    deps: {
      exec,
      isAlive: claude.alive ?? ((): boolean => false),
      delay: async (): Promise<void> => {
        await Promise.resolve();
      },
    },
  });
  onTestFinished(async () => {
    await waitFor(() => !test.app.runtime.caches.worktrees.loading);
  });
  test.bus.emit('session.upserted', session('orig', { title: 'Bridge', cwd: env.home }));
  return { test, env, calls, plain };
}

async function relocate(test: TestApp, sessionId = 'orig'): Promise<void> {
  await test.app.dispatch({ type: 'continueInFolder', sessionId }, {});
}

/** `claude agents` lists the original as a live background job. */
function backgroundJob(args: readonly string[]): ExecResult | undefined {
  if (args[0] !== 'agents') {
    return undefined;
  }
  const job = { id: 'orig0000', pid: JOB_PID, sessionId: 'orig', kind: 'background' };
  return ok(JSON.stringify([job]));
}

describe('continuing a session in another folder', { timeout: 30_000 }, () => {
  it('runs a fork in the background, in a worktree when the folder is in git', async () => {
    const world = await makeWorld();
    onTestFinished(async () => {
      await rm(world.dir, { recursive: true, force: true, maxRetries: 5 });
    });
    const { test, env, calls } = await relocating({
      answer: (args) => {
        if (args.includes('--bg')) {
          return ok('backgrounded · f0f0f0f0 (idle)\n');
        }
        const fork = { id: 'f0f0f0f0', sessionId: 'f0f0f0f0-fork', kind: 'background' };
        return args[0] === 'agents' ? ok(JSON.stringify([fork])) : undefined;
      },
    });
    env.host.folderAnswers.push(world.repo);
    await relocate(test);
    expect(env.host.folderPicks).toStrictEqual(['Continue "Bridge" in']);
    const started = calls.find((args) => args.includes('--bg')) ?? [];
    expect(started.slice(-3)).toStrictEqual(['--resume', 'orig', '--fork-session']);
    const terminal = env.host.terminals.at(-1);
    expect(terminal).toMatchObject({ args: ['attach', 'f0f0f0f0'], sessionId: 'f0f0f0f0-fork' });
    expect(terminal?.cwd.startsWith(worktreeRoot(env.paths))).toBe(true);
    expect(test.app.runtime.sessionWorktrees.has('f0f0f0f0-fork')).toBe(true);
    expect(env.host.infos.at(-1)).toBe(
      `Continuing "Bridge" in ${world.repo}. The original stays in ${env.home}.`,
    );
  });

  it('runs claude itself as a fork with its own id when the background start fails', async () => {
    const { test, env, plain } = await relocating();
    test.bus.emit('session.upserted', session('orig', { title: '', cwd: '' }));
    env.host.folderAnswers.push(plain);
    await relocate(test);
    const terminal = env.host.terminals.at(-1);
    const forkId = terminal?.sessionId ?? '';
    expect(terminal).toMatchObject({
      name: plain,
      cwd: plain,
      args: ['--resume', 'orig', '--fork-session', '--session-id', forkId],
    });
    expect(forkId).not.toBe('orig');
    expect(env.host.warnings).toStrictEqual([]);
    expect(env.host.infos.at(-1)).toBe(`Continuing "orig" in ${plain}.`);
  });

  it('stops a background original only after asking', async () => {
    let stopped = false;
    const { test, env, calls, plain } = await relocating({
      answer: (args) => {
        if (args[0] === 'stop') {
          stopped = true;
          return ok();
        }
        return backgroundJob(args);
      },
      alive: (pid) => pid === JOB_PID && !stopped,
    });
    env.host.folderAnswers.push(plain);
    await relocate(test);
    expect(env.host.questions).toStrictEqual([
      {
        message: `"Bridge" is still running in the background. Stop it and continue a copy in ${plain}?`,
        action: STOP_LABEL,
      },
    ]);
    expect(calls).not.toContainEqual(['stop', 'orig0000']);
    expect(env.host.terminals).toStrictEqual([]);
    env.host.folderAnswers.push(plain);
    env.host.confirmAnswers.push(true);
    await relocate(test);
    expect(calls).toContainEqual(['stop', 'orig0000']);
    expect(env.host.terminals).toHaveLength(1);
  });

  it('stays put, and says so, when Claude Code will not stop the original', async () => {
    const { test, env, plain } = await relocating({
      answer: backgroundJob,
      alive: (pid) => pid === JOB_PID,
    });
    env.host.folderAnswers.push(plain);
    env.host.confirmAnswers.push(true);
    await relocate(test);
    expect(env.host.warnings).toStrictEqual([
      'Claude Code did not stop "Bridge", so Overlord did not continue it.',
    ]);
    expect(env.host.terminals).toStrictEqual([]);
  });

  it('asks before stopping a copy open in another terminal', async () => {
    const { test, env, plain } = await relocating({
      answer: (args) => (args[0] === 'agents' ? ok('[]') : undefined),
      alive: (pid) => pid === TERMINAL_PID,
    });
    await writeJson(path.join(env.paths.sessionsDir, `${String(TERMINAL_PID)}.json`), {
      pid: TERMINAL_PID,
      sessionId: 'orig',
      cwd: env.home,
    });
    env.host.folderAnswers.push(plain);
    await relocate(test);
    expect(env.host.questions.at(-1)?.message).toContain('is still open in another terminal');
    expect(env.host.terminals).toStrictEqual([]);
  });

  it('does nothing for a gone session, a cancelled pick or the folder it is already in', async () => {
    const { test, env } = await relocating();
    await relocate(test, 'gone');
    await relocate(test);
    env.host.folderAnswers.push(env.home);
    await relocate(test);
    expect(env.host.infos).toStrictEqual([
      'That session is gone.',
      `"Bridge" already runs in ${env.home}.`,
    ]);
    expect(env.host.folderPicks).toHaveLength(2);
    expect(env.host.terminals).toStrictEqual([]);
  });

  it('leaves a session the launcher runs alone', async () => {
    const { test, env } = await relocating();
    const spec: LaunchSpec = {
      prompt: 'do it',
      cwd: env.home,
      profileId: null,
      worktree: false,
      maxBudgetUsd: null,
      label: 'one',
    };
    test.app.runtime.launcher.launch([spec], []);
    // The fake query never finishes, so the run stays live.
    await waitFor(() => test.queries.queries.length === 1);
    const sessionId = test.app.runtime.launcher.runs()[0]?.sessionId ?? '';
    test.bus.emit('session.upserted', session(sessionId, { cwd: env.home }));
    await relocate(test, sessionId);
    expect(env.host.infos).toStrictEqual([IN_LAUNCHER]);
    expect(env.host.folderPicks).toStrictEqual([]);
  });
});
