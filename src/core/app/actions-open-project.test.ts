import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../../shared/model.js';
import type { ExecResult } from '../sync/exec.js';

import { NO_FOLDER, PICK_TITLE, WAYS } from './actions-open-project.js';
import { BROWSE_LABEL } from './actions-projects.js';
import { readProjects, storagePath } from './storage.js';
import type { TestApp, TestEnv } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, ok, session, writeText } from './test-helpers/fixtures.js';
import { STARTING } from './worktrees.js';

interface World {
  readonly test: TestApp;
  readonly repo: string;
  readonly notes: string;
}

/** Git knows <root>/repo and the folders under it. Everything else is no repository. */
function gitIn(
  env: TestEnv,
): (call: {
  readonly args: readonly string[];
  readonly options: { readonly cwd?: string };
}) => ExecResult | undefined {
  const repo = path.join(env.root, 'repo');
  return (call) =>
    call.args.includes('--git-common-dir') && (call.options.cwd ?? '').startsWith(repo)
      ? ok(`${repo}/.git\n${repo}\n`)
      : undefined;
}

async function world(...sessions: ((root: string) => SessionSummary)[]): Promise<World> {
  const env = await makeEnv();
  const repo = path.join(env.root, 'repo');
  const notes = path.join(env.root, 'notes');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(notes);
  const test = makeApp(env, { responders: [gitIn(env)] });
  const made = sessions.map((make) => make(env.root));
  for (const item of made) {
    test.bus.emit('session.upserted', item);
  }
  await test.app.runtime.projects.refresh(made.map((item) => item.cwd));
  return { test, repo, notes };
}

const inRepo = (root: string): SessionSummary =>
  session('s1', { cwd: path.join(root, 'repo', 'src') });
const inNotes = (root: string): SessionSummary =>
  session('s2', { cwd: path.join(root, 'notes'), title: 'Notes' });

async function course(test: TestApp): Promise<string> {
  test.env.host.inputAnswers.push('Course');
  await test.app.dispatch({ type: 'newProject', sessionId: 's2' }, {});
  return test.app.runtime.projects.book.projects[0]?.id ?? '';
}

async function book(test: TestApp): Promise<Awaited<ReturnType<typeof readProjects>>> {
  return readProjects(storagePath(test.env.storageDir, 'projects'));
}

describe('openProject', () => {
  it('offers each project whose folder is still there by name, then any folder', async () => {
    const { test, repo } = await world(inRepo, inNotes);
    const id = await course(test);
    await test.app.runtime.projects.update((current) => ({
      ...current,
      repos: [...current.repos, path.join(test.env.root, 'gone')],
    }));
    await test.app.dispatch({ type: 'openProject' }, {});
    expect(test.env.host.picks).toStrictEqual([
      {
        placeholder: PICK_TITLE,
        items: [
          { id, label: 'Course', description: NO_FOLDER },
          { id: `git:${repo}`, label: 'repo', description: repo },
          { id: 'browse', label: BROWSE_LABEL, description: '' },
        ],
      },
    ]);
  });

  it('keeps a repository to open after its sessions are gone', async () => {
    const { test, repo } = await world(inRepo);
    const { repos } = await book(test);
    expect(repos).toStrictEqual([repo]);
    const later = makeApp(test.env);
    await later.app.runtime.projects.load();
    later.env.host.pickAnswers.push(`git:${repo}`, 'window');
    await later.app.dispatch({ type: 'openProject' }, {});
    expect(later.env.host.picks.at(-1)).toStrictEqual({ placeholder: 'Open repo', items: WAYS });
    expect(later.env.host.windows).toStrictEqual([repo]);
  });

  it('opens the project the way picked, and does nothing when a pick is cancelled', async () => {
    const { test, repo } = await world(inRepo);
    test.env.host.pickAnswers.push(`git:${repo}`, 'here', `git:${repo}`, null, null);
    for (let round = 0; round < 3; round += 1) {
      await test.app.dispatch({ type: 'openProject' }, {});
    }
    expect(test.env.host.folders).toStrictEqual([repo]);
    expect(test.env.host.windows).toStrictEqual([]);
    expect(test.env.host.terminals).toStrictEqual([]);
  });

  it('starts a session in the project under a progress notification', async () => {
    const { test, notes } = await world(inNotes);
    const id = await course(test);
    test.env.host.pickAnswers.push(id, notes, 'session');
    await test.app.dispatch({ type: 'openProject' }, {});
    const { projects } = await book(test);
    expect(projects).toStrictEqual([{ id, name: 'Course', folder: notes }]);
    expect(test.env.host.progress).toStrictEqual([STARTING]);
    expect(test.env.host.terminals.at(-1)).toMatchObject({ name: 'Claude Code', cwd: notes });
  });

  it('opens a project made by hand only once it has a folder', async () => {
    const { test } = await world(inNotes);
    const id = await course(test);
    test.env.host.pickAnswers.push(id, 'browse');
    await test.app.dispatch({ type: 'openProject' }, {});
    expect(test.env.host.picks).toHaveLength(2);
    const { projects } = await book(test);
    expect(projects[0]?.folder).toBeNull();
  });
});

/** Picks a folder from disk in the project list and opens it in a new window. */
async function browse(test: TestApp, folder: string | null): Promise<void> {
  test.env.host.pickAnswers.push('browse', 'window');
  test.env.host.folderAnswers.push(folder);
  await test.app.dispatch({ type: 'openProject' }, {});
}

describe('openProject with a folder from disk', () => {
  it('opens the repository a folder is in and remembers it', async () => {
    const { test, repo } = await world();
    await browse(test, path.join(repo, 'src'));
    expect(test.env.host.folderPicks).toStrictEqual([PICK_TITLE]);
    expect(test.env.host.picks.at(-1)?.placeholder).toBe('Open repo');
    expect(test.env.host.windows).toStrictEqual([repo]);
    const { repos } = await book(test);
    expect(repos).toStrictEqual([repo]);
  });

  it('still opens a repository it could not remember', async () => {
    const { test, repo } = await world();
    await writeText(storagePath(test.env.storageDir, 'projects'), '{');
    await browse(test, repo);
    expect(test.env.host.picks.at(-1)?.placeholder).toBe('Open repo');
    expect(test.env.host.windows).toStrictEqual([repo]);
  });

  it('makes a project for a folder in none, named as typed', async () => {
    const { test, notes } = await world();
    test.env.host.inputAnswers.push(null, 'Notes');
    test.env.host.pickAnswers.push('browse');
    test.env.host.folderAnswers.push(notes);
    await test.app.dispatch({ type: 'openProject' }, {});
    expect(test.env.host.picks).toHaveLength(1);
    await browse(test, notes);
    expect(test.env.host.inputs).toStrictEqual([
      { prompt: 'Project name', value: 'notes' },
      { prompt: 'Project name', value: 'notes' },
    ]);
    const { projects, rules } = await book(test);
    expect(projects).toMatchObject([{ name: 'Notes', folder: notes }]);
    expect(rules).toStrictEqual([{ folder: notes, projectId: projects[0]?.id }]);
    expect(test.env.host.windows).toStrictEqual([notes]);
  });

  it('opens a folder already in a project as that project, and gives it the folder', async () => {
    const { test, notes } = await world(inNotes);
    const id = await course(test);
    await browse(test, notes);
    expect(test.env.host.inputs).toHaveLength(1);
    expect(test.env.host.picks.at(-1)?.placeholder).toBe('Open Course');
    const { projects } = await book(test);
    expect(projects).toStrictEqual([{ id, name: 'Course', folder: notes }]);
    expect(test.env.host.windows).toStrictEqual([notes]);
    await browse(test, notes);
    expect(test.env.host.windows).toStrictEqual([notes, notes]);
  });

  it('asks to try again while another look at the folder is under way', async () => {
    const { test, notes } = await world();
    // The look at the folder another check started has not finished yet.
    vi.spyOn(test.app.runtime.projects, 'refresh').mockResolvedValueOnce();
    await browse(test, notes);
    expect(test.env.host.infos).toStrictEqual([
      'Overlord is still looking at that folder. Try again in a moment.',
    ]);
    expect(test.env.host.windows).toStrictEqual([]);
  });

  it('does nothing when the folder picker is cancelled', async () => {
    const { test } = await world();
    await browse(test, null);
    expect(test.env.host.picks).toHaveLength(1);
    expect(test.env.host.windows).toStrictEqual([]);
  });
});

describe('newProjectSession', () => {
  it('starts a session in the project folder, or says why it cannot', async () => {
    const { test, repo } = await world(inRepo, inNotes);
    const id = await course(test);
    await test.app.dispatch({ type: 'newProjectSession', projectId: 'nobody' }, {});
    await test.app.dispatch({ type: 'newProjectSession', projectId: id }, {});
    expect(test.env.host.infos).toStrictEqual([
      'That project is gone.',
      'Set a folder for Course first.',
    ]);
    await test.app.dispatch({ type: 'newProjectSession', projectId: `git:${repo}` }, {});
    expect(test.env.host.progress).toStrictEqual([STARTING]);
    expect(test.env.host.terminals.at(-1)).toMatchObject({ cwd: repo });
  });
});
