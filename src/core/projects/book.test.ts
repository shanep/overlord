import { describe, expect, it } from 'vitest';

import type { ProjectBook } from './book.js';
import {
  addProject,
  assignFolder,
  EMPTY_BOOK,
  gitProjectId,
  ignoreFolder,
  isInside,
  projectFolders,
  projectSummaries,
  removeProject,
  renameProject,
  resolveProject,
  setProjectFolder,
} from './book.js';

const COURSE = { id: 'p1', name: 'Course', folder: null };

function book(rules: ProjectBook['rules']): ProjectBook {
  return { projects: [COURSE], rules };
}

describe('isInside', () => {
  it('matches the folder itself and folders under it, not siblings with the same prefix', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/b/c', '/a/b/')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
  });
});

describe('resolveProject', () => {
  it('puts a repository in its own git project', () => {
    expect(resolveProject(EMPTY_BOOK, '/repo/src', '/repo')).toStrictEqual({
      projectId: 'git:/repo',
      folder: '/repo',
      ignored: false,
    });
  });

  it('moves a repository only by a rule on its own root', () => {
    expect(
      resolveProject(book([{ folder: '/repo', projectId: 'p1' }]), '/repo/src', '/repo'),
    ).toStrictEqual({ projectId: 'p1', folder: '/repo', ignored: false });
    // Rules on a parent, never ask rules and rules for deleted projects leave it alone.
    for (const rule of [
      { folder: '/', projectId: 'p1' },
      { folder: '/repo', projectId: null },
      { folder: '/repo', projectId: 'gone' },
    ]) {
      expect(resolveProject(book([rule]), '/repo', '/repo').projectId).toBe('git:/repo');
    }
  });

  it('leaves a folder with no rule unassigned', () => {
    expect(resolveProject(EMPTY_BOOK, '/notes', null)).toStrictEqual({
      projectId: null,
      folder: '/notes',
      ignored: false,
    });
  });

  it('follows the closest rule above a folder', () => {
    const rules = book([
      { folder: '/home', projectId: null },
      { folder: '/home/notes', projectId: 'p1' },
      { folder: '/home/notes/old', projectId: null },
      { folder: '/home/other', projectId: 'gone' },
    ]);
    expect(resolveProject(rules, '/home/notes/week1', null)).toStrictEqual({
      projectId: 'p1',
      folder: '/home/notes/week1',
      ignored: false,
    });
    expect(resolveProject(rules, '/home/notes/old/x', null)).toStrictEqual({
      projectId: null,
      folder: '/home/notes/old/x',
      ignored: true,
    });
    expect(resolveProject(rules, '/home/other', null).ignored).toBe(true);
    expect(resolveProject(rules, '/srv', null).ignored).toBe(false);
  });

  it('can put a folder in a git project', () => {
    const rules = book([{ folder: '/notes', projectId: gitProjectId('/repo') }]);
    expect(resolveProject(rules, '/notes', null).projectId).toBe('git:/repo');
  });
});

describe('book changes', () => {
  it('replaces a folder rule, and drops it when the folder goes back to its own project', () => {
    const start = book([{ folder: '/repo', projectId: 'p1' }]);
    expect(assignFolder(start, '/repo', 'p2', 'git:/repo').rules).toStrictEqual([
      { folder: '/repo', projectId: 'p2' },
    ]);
    expect(assignFolder(start, '/repo', 'git:/repo', 'git:/repo').rules).toStrictEqual([]);
    expect(assignFolder(EMPTY_BOOK, '/notes', 'p1', null).rules).toStrictEqual([
      { folder: '/notes', projectId: 'p1' },
    ]);
  });

  it('marks a folder never to ask about', () => {
    expect(ignoreFolder(book([{ folder: '/tmp', projectId: 'p1' }]), '/tmp')).toStrictEqual(
      book([{ folder: '/tmp', projectId: null }]),
    );
  });

  it('adds, renames and removes projects with their rules', () => {
    const added = addProject(EMPTY_BOOK, COURSE);
    expect(added.projects).toStrictEqual([COURSE]);
    const two = addProject(added, { id: 'p2', name: 'Two', folder: null });
    expect(renameProject(two, 'p1', 'Class').projects).toStrictEqual([
      { id: 'p1', name: 'Class', folder: null },
      { id: 'p2', name: 'Two', folder: null },
    ]);
    const withRules = {
      projects: two.projects,
      rules: [
        { folder: '/a', projectId: 'p1' },
        { folder: '/b', projectId: 'p2' },
        { folder: '/c', projectId: null },
      ],
    };
    expect(removeProject(withRules, 'p1')).toStrictEqual({
      projects: [{ id: 'p2', name: 'Two', folder: null }],
      rules: [
        { folder: '/b', projectId: 'p2' },
        { folder: '/c', projectId: null },
      ],
    });
  });
});

describe('project folders', () => {
  it('sets the folder of one project only', () => {
    const two = addProject(book([]), { id: 'p2', name: 'Two', folder: null });
    expect(setProjectFolder(two, 'p2', '/two')).toStrictEqual({
      projects: [COURSE, { id: 'p2', name: 'Two', folder: '/two' }],
      rules: [],
    });
  });

  it('lists the folders placed in a project, not in others or ignored', () => {
    const rules = book([
      { folder: '/a', projectId: 'p1' },
      { folder: '/b', projectId: 'p2' },
      { folder: '/c', projectId: null },
      { folder: '/d', projectId: 'p1' },
    ]);
    expect(projectFolders(rules, 'p1')).toStrictEqual(['/a', '/d']);
  });
});

describe('projectSummaries', () => {
  it('gives a hand made project the folder set for it', () => {
    const set = setProjectFolder(book([]), 'p1', '/course');
    expect(projectSummaries(set, [])).toStrictEqual([
      { id: 'p1', name: 'Course', kind: 'manual', folder: '/course' },
    ]);
  });

  it('lists hand made projects and each repository once', () => {
    expect(projectSummaries(book([]), ['/r/app', '/r/app', '/r/web'])).toStrictEqual([
      { id: 'p1', name: 'Course', kind: 'manual', folder: null },
      { id: 'git:/r/app', name: 'app', kind: 'git', folder: '/r/app' },
      { id: 'git:/r/web', name: 'web', kind: 'git', folder: '/r/web' },
    ]);
  });

  it('adds the parent folder to repositories that share a name', () => {
    const named = projectSummaries(
      { projects: [{ id: 'p1', name: 'app', folder: null }], rules: [] },
      ['/work/app', '/play/app'],
    ).map((item) => item.name);
    expect(named).toStrictEqual(['app', 'app (work)', 'app (play)']);
  });
});
