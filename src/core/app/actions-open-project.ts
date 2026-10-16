// Open a project without a session in it first: pick any project Overlord
// knows, or a folder, then start a session there, open it in its own
// window, or add it to this one.

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { ProjectSummary } from '../../shared/protocol.js';
import { addProject, assignFolder, resolveProject, setProjectFolder } from '../projects/book.js';

import type { ActionHandlers } from './action-types.js';
import { askName, BROWSE_LABEL, chooseFolder, folderOf } from './actions-projects.js';
import type { PickItem } from './host-port.js';
import type { Runtime } from './runtime.js';
import { fleetFor } from './views/fleet.js';
import { newSession, STARTING } from './worktrees.js';

type OpenActions = 'openProject' | 'newProjectSession';

const BROWSE_ID = 'browse';
export const PICK_TITLE = 'Open a project';
export const NO_FOLDER = 'no folder yet';

type Way = 'session' | 'window' | 'here';

export const WAYS: readonly (PickItem & { readonly id: Way })[] = [
  { id: 'session', label: 'New Claude Code session', description: 'in its own worktree' },
  { id: 'window', label: 'Open in a new window', description: '' },
  { id: 'here', label: 'Add to this window', description: 'and show it in the Explorer' },
];

interface Target {
  readonly name: string;
  readonly folder: string;
}

/** A project to offer: one whose folder is still there, or one made by hand that has none yet. */
async function offer(rt: Runtime, project: ProjectSummary): Promise<PickItem | null> {
  if (project.folder === null) {
    return { id: project.id, label: project.name, description: NO_FOLDER };
  }
  return (await rt.fs.kind(project.folder)) === 'directory'
    ? { id: project.id, label: project.name, description: project.folder }
    : null;
}

async function projectItems(rt: Runtime): Promise<PickItem[]> {
  const offered = await Promise.all(fleetFor(rt).projects.map(async (item) => offer(rt, item)));
  return offered
    .filter((item) => item !== null)
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

/** A known project, after asking for its folder when it has none. */
async function known(rt: Runtime, project: ProjectSummary): Promise<Target | null> {
  if (project.folder !== null) {
    return { name: project.name, folder: project.folder };
  }
  const folder = await chooseFolder(rt, project.id, project.name);
  if (folder === null) {
    return null;
  }
  await rt.projects.update((book) => setProjectFolder(book, project.id, folder));
  return { name: project.name, folder };
}

/**
 * The project for a folder picked from disk: its git repository, the project
 * a rule already puts it in, or a new project made for it.
 */
async function fromFolder(rt: Runtime, folder: string): Promise<Target | null> {
  await rt.projects.refresh([folder]);
  const root = rt.projects.rootOf(folder);
  if (root === undefined) {
    rt.host.showInfo('Overlord is still looking at that folder. Try again in a moment.');
    return null;
  }
  if (root !== null) {
    const name = fleetFor(rt).projects.find((item) => item.folder === root)?.name;
    return { name: name ?? path.basename(root), folder: root };
  }
  const { projectId } = resolveProject(rt.projects.book, folder, null);
  const placed = rt.projects.book.projects.find((item) => item.id === projectId);
  if (placed !== undefined) {
    if (placed.folder === null) {
      await rt.projects.update((book) => setProjectFolder(book, placed.id, folder));
    }
    return { name: placed.name, folder };
  }
  const name = await askName(rt, path.basename(folder));
  if (name === null) {
    return null;
  }
  const id = randomUUID();
  await rt.projects.update((book) =>
    assignFolder(addProject(book, { id, name, folder }), folder, id, null),
  );
  return { name, folder };
}

async function pickTarget(rt: Runtime): Promise<Target | null> {
  const items = [
    ...(await projectItems(rt)),
    { id: BROWSE_ID, label: BROWSE_LABEL, description: '' },
  ];
  const picked = await rt.host.quickPick(items, PICK_TITLE);
  if (picked === BROWSE_ID) {
    const folder = await rt.host.pickFolder(PICK_TITLE);
    return folder === null ? null : fromFolder(rt, folder);
  }
  const project = fleetFor(rt).projects.find((item) => item.id === picked);
  return project === undefined ? null : known(rt, project);
}

async function startIn(rt: Runtime, folder: string): Promise<void> {
  await rt.host.withProgress(STARTING, async () => newSession(rt, folder));
}

const OPENERS: Readonly<Record<Way, (rt: Runtime, folder: string) => Promise<void>>> = {
  session: startIn,
  window: async (rt, folder) => rt.host.openWindow(folder),
  here: async (rt, folder) => rt.host.showFolder(folder),
};

function isWay(value: string | null): value is Way {
  return WAYS.some((way) => way.id === value);
}

export const openProjectActions: ActionHandlers<OpenActions> = {
  openProject: async ({ rt }) => {
    const target = await pickTarget(rt);
    if (target === null) {
      return;
    }
    const way = await rt.host.quickPick(WAYS, `Open ${target.name}`);
    if (isWay(way)) {
      await OPENERS[way](rt, target.folder);
    }
  },
  newProjectSession: async ({ rt }, action) => {
    const folder = await folderOf(rt, action.projectId);
    if (folder !== null) {
      await startIn(rt, folder);
    }
  },
};
