// Which project each session belongs to. A git repository is a project on
// its own, named after its main checkout. Any other folder needs a rule the
// user made: it puts the folder in a project, or says never to ask about it.
// Every function here is pure, so the rules are easy to test.

import path from 'node:path';

import type { ProjectSummary, SessionProject } from '../../shared/protocol.js';

export interface ManualProject {
  readonly id: string;
  readonly name: string;
  /** The folder the fleet opens for this project, or null until the user sets one. */
  readonly folder: string | null;
}

/** A folder the user placed by hand. A null project means never ask about it. */
interface FolderRule {
  readonly folder: string;
  readonly projectId: string | null;
}

export interface ProjectBook {
  readonly projects: readonly ManualProject[];
  readonly rules: readonly FolderRule[];
}

export const EMPTY_BOOK: ProjectBook = { projects: [], rules: [] };

const GIT_PREFIX = 'git:';

export function gitProjectId(repoRoot: string): string {
  return `${GIT_PREFIX}${repoRoot}`;
}

export function isInside(child: string, parent: string): boolean {
  if (child === parent) {
    return true;
  }
  const base = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(base);
}

function knownProject(book: ProjectBook, projectId: string): boolean {
  return projectId.startsWith(GIT_PREFIX) || book.projects.some((item) => item.id === projectId);
}

/**
 * The project for a session in cwd, given the main checkout of its git
 * repository or null when it has none. A repository only follows a rule made
 * for its own root, so a rule on a parent folder never swallows the repos
 * under it. Any other folder follows the closest rule above it.
 */
export function resolveProject(
  book: ProjectBook,
  cwd: string,
  repoRoot: string | null,
): SessionProject {
  if (repoRoot !== null) {
    const rule = book.rules.find(
      (item) =>
        item.folder === repoRoot && item.projectId !== null && knownProject(book, item.projectId),
    );
    return {
      projectId: rule?.projectId ?? gitProjectId(repoRoot),
      folder: repoRoot,
      ignored: false,
    };
  }
  const closest = book.rules
    .filter((rule) => isInside(cwd, rule.folder))
    .filter((rule) => rule.projectId === null || knownProject(book, rule.projectId))
    .toSorted((left, right) => right.folder.length - left.folder.length)
    .at(0);
  return {
    projectId: closest?.projectId ?? null,
    folder: cwd,
    ignored: closest?.projectId === null,
  };
}

function withoutRule(book: ProjectBook, folder: string): readonly FolderRule[] {
  return book.rules.filter((rule) => rule.folder !== folder);
}

/**
 * Put a folder in a project. Choosing the project the folder would get on
 * its own, its git repository, just drops the rule.
 */
export function assignFolder(
  book: ProjectBook,
  folder: string,
  projectId: string,
  automatic: string | null,
): ProjectBook {
  const rules = withoutRule(book, folder);
  return {
    projects: book.projects,
    rules: projectId === automatic ? rules : [...rules, { folder, projectId }],
  };
}

/** Never ask about this folder or the folders under it. */
export function ignoreFolder(book: ProjectBook, folder: string): ProjectBook {
  return {
    projects: book.projects,
    rules: [...withoutRule(book, folder), { folder, projectId: null }],
  };
}

export function addProject(book: ProjectBook, project: ManualProject): ProjectBook {
  return { projects: [...book.projects, project], rules: book.rules };
}

export function renameProject(book: ProjectBook, projectId: string, name: string): ProjectBook {
  return {
    projects: book.projects.map((item) => (item.id === projectId ? { ...item, name } : item)),
    rules: book.rules,
  };
}

export function setProjectFolder(
  book: ProjectBook,
  projectId: string,
  folder: string,
): ProjectBook {
  return {
    projects: book.projects.map((item) => (item.id === projectId ? { ...item, folder } : item)),
    rules: book.rules,
  };
}

/** The folders placed in a project by hand, in the order they were placed. */
export function projectFolders(book: ProjectBook, projectId: string): readonly string[] {
  return book.rules.filter((rule) => rule.projectId === projectId).map((rule) => rule.folder);
}

/** Remove a project and its rules, so its folders go back to their repo or to Unassigned. */
export function removeProject(book: ProjectBook, projectId: string): ProjectBook {
  return {
    projects: book.projects.filter((item) => item.id !== projectId),
    rules: book.rules.filter((rule) => rule.projectId !== projectId),
  };
}

/**
 * Every hand made project, plus the git projects in use. Two projects with
 * the same name get their parent folder added, so the list never shows twins.
 */
export function projectSummaries(
  book: ProjectBook,
  repoRoots: readonly string[],
): readonly ProjectSummary[] {
  const manual = book.projects.map((item): ProjectSummary => ({
    id: item.id,
    name: item.name,
    kind: 'manual',
    folder: item.folder,
  }));
  const git = [...new Set(repoRoots)].map((root): ProjectSummary => ({
    id: gitProjectId(root),
    name: path.basename(root),
    kind: 'git',
    folder: root,
  }));
  const all = [...manual, ...git];
  const shared = (name: string): boolean => all.filter((item) => item.name === name).length > 1;
  return all.map((item) =>
    item.folder !== null && shared(item.name)
      ? { ...item, name: `${item.name} (${path.basename(path.dirname(item.folder))})` }
      : item,
  );
}
