import { describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../../shared/model.js';
import type { LaunchRun } from '../../shared/protocol.js';
import type { ExecResult } from '../sync/exec.js';

import { ADD_LABEL, checkProjects, IGNORE_LABEL, NEW_LABEL } from './actions-projects.js';
import { readProjects, storagePath } from './storage.js';
import type { TestApp } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, ok, session, settle, waitFor } from './test-helpers/fixtures.js';
import { fleetFor } from './views/fleet.js';

/** Git knows /repo and the folders under it. Everything else is no repository. */
function gitRepo(call: {
  readonly args: readonly string[];
  readonly options: { readonly cwd?: string };
}): ExecResult | undefined {
  const cwd = call.options.cwd ?? '';
  return call.args.includes('--git-common-dir') && cwd.startsWith('/repo')
    ? ok('/repo/.git\n/repo\n')
    : undefined;
}

async function app(...sessions: SessionSummary[]): Promise<TestApp> {
  const env = await makeEnv();
  const test = makeApp(env, { responders: [gitRepo] });
  for (const item of sessions) {
    test.bus.emit('session.upserted', item);
  }
  await test.app.runtime.projects.refresh(sessions.map((item) => item.cwd));
  return test;
}

async function book(test: TestApp): Promise<Awaited<ReturnType<typeof readProjects>>> {
  return readProjects(storagePath(test.env.storageDir, 'projects'));
}

function projectOf(test: TestApp, sessionId: string): string | null | undefined {
  return fleetFor(test.app.runtime).sessionProjects[sessionId]?.projectId;
}

function byText(left: string, right: string): number {
  return left.localeCompare(right);
}

const NOTES = session('s1', { cwd: '/notes', title: 'Notes' });
const REPO = session('s2', { cwd: '/repo/src' });

describe('moveSession', () => {
  it('explains when a session has no folder, is unknown, or is still being looked at', async () => {
    const test = await app(session('bare', { cwd: '' }));
    test.bus.emit('session.upserted', session('fresh', { cwd: '/fresh' }));
    for (const sessionId of ['bare', 'nobody']) {
      await test.app.dispatch({ type: 'moveSession', sessionId }, {});
    }
    await test.app.dispatch({ type: 'newProject', sessionId: 'fresh' }, {});
    expect(test.env.host.infos).toStrictEqual([
      'That session has no folder to put in a project.',
      'That session has no folder to put in a project.',
      'Overlord is still looking at that session folder. Try again in a moment.',
    ]);
    expect(test.env.host.picks).toStrictEqual([]);
  });

  it('offers every other project, a new one, and never asking for a folder with no repository', async () => {
    const test = await app(NOTES, REPO);
    await test.app.dispatch({ type: 'moveSession', sessionId: 's1' }, {});
    expect(test.env.host.picks).toStrictEqual([
      {
        placeholder: 'Move every session in /notes to',
        items: [
          { id: 'git:/repo', label: 'repo', description: '/repo' },
          { id: 'new', label: NEW_LABEL, description: '' },
          { id: 'ignore', label: IGNORE_LABEL, description: '' },
        ],
      },
    ]);
    // A repository is never unassigned, so it is not offered the never ask choice.
    await test.app.dispatch({ type: 'moveSession', sessionId: 's2' }, {});
    expect(test.env.host.picks[1]?.items.map((item) => item.id)).toStrictEqual(['new']);
    expect(await book(test)).toStrictEqual({ projects: [], rules: [] });
  });

  it('moves a folder into a project and a repository back to its own', async () => {
    const test = await app(NOTES, REPO);
    test.env.host.pickAnswers.push('git:/repo');
    await test.app.dispatch({ type: 'moveSession', sessionId: 's1' }, {});
    expect(projectOf(test, 's1')).toBe('git:/repo');
    test.env.host.pickAnswers.push('new');
    test.env.host.inputAnswers.push('  Course  ');
    await test.app.dispatch({ type: 'moveSession', sessionId: 's2' }, {});
    const { projects } = await book(test);
    expect(projects.map((item) => item.name)).toStrictEqual(['Course']);
    const courseId = projects[0]?.id ?? '';
    expect(projectOf(test, 's2')).toBe(courseId);
    expect(test.env.host.inputs).toStrictEqual([{ prompt: 'Project name', value: 'repo' }]);
    await test.app.dispatch({ type: 'moveSession', sessionId: 's1' }, {});
    expect(test.env.host.picks.at(-1)?.items[0]).toStrictEqual({
      id: courseId,
      label: 'Course',
      description: 'project',
    });
    test.env.host.pickAnswers.push('git:/repo');
    await test.app.dispatch({ type: 'moveSession', sessionId: 's2' }, {});
    expect(projectOf(test, 's2')).toBe('git:/repo');
    const { rules } = await book(test);
    expect(rules).toStrictEqual([{ folder: '/notes', projectId: 'git:/repo' }]);
  });

  it('marks a folder never to ask about, and does nothing when the pick is cancelled', async () => {
    const test = await app(NOTES);
    await test.app.dispatch({ type: 'moveSession', sessionId: 's1' }, {});
    expect(await book(test)).toStrictEqual({ projects: [], rules: [] });
    test.env.host.pickAnswers.push('ignore');
    await test.app.dispatch({ type: 'moveSession', sessionId: 's1' }, {});
    expect(fleetFor(test.app.runtime).sessionProjects['s1']).toStrictEqual({
      projectId: null,
      folder: '/notes',
      ignored: true,
    });
  });
});

describe('newProject', () => {
  it('makes nothing when the name is cancelled or blank', async () => {
    const test = await app(NOTES);
    test.env.host.inputAnswers.push(null, ' '.repeat(3));
    await test.app.dispatch({ type: 'newProject', sessionId: 's1' }, {});
    await test.app.dispatch({ type: 'newProject', sessionId: 's1' }, {});
    expect(await book(test)).toStrictEqual({ projects: [], rules: [] });
  });
});

async function withCourse(): Promise<{ readonly test: TestApp; readonly id: string }> {
  const test = await app(NOTES);
  test.env.host.inputAnswers.push('Course');
  await test.app.dispatch({ type: 'newProject', sessionId: 's1' }, {});
  return { test, id: test.app.runtime.projects.book.projects[0]?.id ?? '' };
}

describe('renameProject and deleteProject', () => {
  it('only changes projects made by hand', async () => {
    const test = await app(REPO);
    await test.app.dispatch({ type: 'renameProject', projectId: 'git:/repo' }, {});
    await test.app.dispatch({ type: 'deleteProject', projectId: 'git:/repo' }, {});
    expect(test.env.host.infos).toStrictEqual([
      'Only a project made by hand can be renamed.',
      'Only a project made by hand can be deleted.',
    ]);
  });

  it('renames only to a new, non blank name', async () => {
    const { test, id } = await withCourse();
    test.env.host.inputAnswers.push(null, ' ', 'Course', 'Class');
    for (let round = 0; round < 4; round += 1) {
      await test.app.dispatch({ type: 'renameProject', projectId: id }, {});
    }
    expect(test.env.host.inputs.at(-1)).toStrictEqual({ prompt: 'Project name', value: 'Course' });
    const { projects } = await book(test);
    expect(projects).toStrictEqual([{ id, name: 'Class' }]);
  });

  it('deletes after a yes, and the sessions go back to Unassigned', async () => {
    const { test, id } = await withCourse();
    expect(projectOf(test, 's1')).toBe(id);
    await test.app.dispatch({ type: 'deleteProject', projectId: id }, {});
    expect(projectOf(test, 's1')).toBe(id);
    test.env.host.confirmAnswers.push(true);
    await test.app.dispatch({ type: 'deleteProject', projectId: id }, {});
    expect(test.env.host.questions.at(-1)).toStrictEqual({
      message:
        'Delete the project "Course"? Its sessions go back to their repository or to Unassigned.',
      action: 'Delete',
    });
    expect(projectOf(test, 's1')).toBeNull();
    expect(await book(test)).toStrictEqual({ projects: [], rules: [] });
  });
});

describe('checkProjects', () => {
  it('asks once per folder about live sessions this window runs that are in no project', async () => {
    const test = await app();
    const { runtime } = test.app;
    test.bus.emit('session.upserted', NOTES);
    test.bus.emit('session.upserted', session('s3', { cwd: '/notes', title: '' }));
    test.bus.emit('session.upserted', session('done', { cwd: '/old', state: 'done' }));
    test.bus.emit('session.upserted', session('other', { cwd: '/other' }));
    test.bus.emit('session.upserted', session('bare', { cwd: '' }));
    test.bus.emit('session.upserted', REPO);
    for (const id of ['s1', 's3', 'done', 'bare', 's2']) {
      runtime.sessionWorktrees.set(id, '/wt');
    }
    await checkProjects(runtime);
    await checkProjects(runtime);
    await settle();
    expect(test.env.host.asks).toStrictEqual([
      {
        message: '"Notes" runs in /notes, which is not in a project.',
        actions: [ADD_LABEL, NEW_LABEL, IGNORE_LABEL],
      },
    ]);
  });

  it('counts sessions in a terminal here or launched from here, and calls an untitled one a session', async () => {
    const test = await app();
    const { runtime } = test.app;
    test.bus.emit('session.upserted', session('tab', { cwd: '/a', title: '' }));
    test.bus.emit('session.upserted', session('run', { cwd: '/b' }));
    vi.spyOn(runtime.places, 'terminalFor').mockImplementation((id) => (id === 'tab' ? 7 : null));
    const run: LaunchRun = {
      id: 'r1',
      batchId: 'b1',
      spec: {
        prompt: '',
        cwd: '/b',
        profileId: null,
        worktree: false,
        maxBudgetUsd: null,
        label: '',
      },
      sessionId: 'run',
      state: 'running',
      costUsd: 0,
      turns: 0,
      durationMs: 0,
      result: null,
      worktreePath: null,
    };
    vi.spyOn(runtime.launcher, 'runs').mockReturnValue([run]);
    await checkProjects(runtime);
    await settle();
    expect(test.env.host.asks.map((item) => item.message)).toStrictEqual([
      'A session runs in /a, which is not in a project.',
      '"title run" runs in /b, which is not in a project.',
    ]);
  });

  it('acts on each answer', async () => {
    const test = await app();
    const { runtime } = test.app;
    const { host } = test.env;
    for (const [id, cwd] of [
      ['add', '/add'],
      ['new', '/new'],
      ['ignore', '/ignore'],
      ['dismiss', '/dismiss'],
    ] as const) {
      test.bus.emit('session.upserted', session(id, { cwd }));
      runtime.sessionWorktrees.set(id, '/wt');
    }
    host.askAnswers.push(ADD_LABEL, NEW_LABEL, IGNORE_LABEL, null);
    host.pickAnswers.push('new');
    host.inputAnswers.push('Added', 'Made');
    await checkProjects(runtime);
    await waitFor(() => runtime.projects.book.rules.length === 3);
    const { projects, rules } = await book(test);
    expect(projects.map((item) => item.name).toSorted(byText)).toStrictEqual(['Added', 'Made']);
    expect(
      rules.map((rule) => `${rule.folder} ${String(rule.projectId === null)}`).toSorted(byText),
    ).toStrictEqual(['/add false', '/ignore true', '/new false']);
  });

  it('reports a failure while asking', async () => {
    const test = await app();
    const { runtime } = test.app;
    test.bus.emit('session.upserted', NOTES);
    runtime.sessionWorktrees.set('s1', '/wt');
    vi.spyOn(test.env.host, 'ask').mockRejectedValue(new Error('no window'));
    await checkProjects(runtime);
    await settle();
    expect(test.app.errorList().map((error) => [error.source, error.message])).toStrictEqual([
      ['projects', 'no window'],
    ]);
  });

  it('reports git failing outright and leaves the folder unassigned', async () => {
    const env = await makeEnv();
    const test = makeApp(env, {
      responders: [
        (call): ExecResult | undefined => {
          if (call.args.includes('--git-common-dir')) {
            throw new Error('spawn failed');
          }
          return undefined;
        },
      ],
    });
    await test.app.runtime.projects.refresh(['/somewhere']);
    expect(test.app.runtime.projects.rootOf('/somewhere')).toBeNull();
    expect(test.app.errorList().map((error) => error.message)).toStrictEqual(['spawn failed']);
  });
});
