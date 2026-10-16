// Project actions: move a session's folder into a project, make a new
// project, rename or delete one, and ask about sessions that are in none.

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { SessionSummary } from '../../shared/model.js';
import type { SessionProject } from '../../shared/protocol.js';
import {
  addProject,
  assignFolder,
  gitProjectId,
  ignoreFolder,
  removeProject,
  renameProject,
} from '../projects/book.js';

import type { ActionHandlers } from './action-types.js';
import { messageOf } from './errors.js';
import type { PickItem } from './host-port.js';
import type { FileWatchFunction, IntervalFunction } from './process.js';
import { PROJECTS_REFRESH_MS } from './projects.js';
import type { Runtime } from './runtime.js';
import { fleetFor } from './views/fleet.js';

type ProjectActions = 'moveSession' | 'newProject' | 'renameProject' | 'deleteProject';

const NEW_ID = 'new';
const IGNORE_ID = 'ignore';
export const ADD_LABEL = 'Add to project…';
export const NEW_LABEL = 'New project…';
export const IGNORE_LABEL = 'Never ask for this folder';
const SOURCE = 'projects';

interface Placed {
  readonly session: SessionSummary;
  readonly project: SessionProject;
}

/** The session and its project, or null after telling the user why there is none. */
function placed(rt: Runtime, sessionId: string): Placed | null {
  const session = fleetFor(rt).sessions.find((item) => item.id === sessionId);
  if (session === undefined || session.cwd === '') {
    rt.host.showInfo('That session has no folder to put in a project.');
    return null;
  }
  const project = rt.projects.resolve(session.cwd);
  if (project === null) {
    rt.host.showInfo('Overlord is still looking at that session folder. Try again in a moment.');
    return null;
  }
  return { session, project };
}

/** The project a folder gets on its own: its git repository, or none. */
function automaticFor(rt: Runtime, cwd: string): string | null {
  const root = rt.projects.rootOf(cwd);
  return root === undefined || root === null ? null : gitProjectId(root);
}

async function assign(rt: Runtime, target: Placed, projectId: string): Promise<void> {
  const automatic = automaticFor(rt, target.session.cwd);
  await rt.projects.update((book) =>
    assignFolder(book, target.project.folder, projectId, automatic),
  );
}

/** The name typed for a project, or null when it was cancelled or left blank. */
async function askName(rt: Runtime, value: string): Promise<string | null> {
  const answer = await rt.host.inputBox({ prompt: 'Project name', value });
  const name = answer?.trim() ?? '';
  return name === '' ? null : name;
}

async function createFor(rt: Runtime, target: Placed): Promise<void> {
  const name = await askName(rt, path.basename(target.project.folder));
  if (name === null) {
    return;
  }
  const id = randomUUID();
  await rt.projects.update((book) =>
    assignFolder(addProject(book, { id, name }), target.project.folder, id, null),
  );
}

async function ignore(rt: Runtime, target: Placed): Promise<void> {
  await rt.projects.update((book) => ignoreFolder(book, target.project.folder));
}

async function moveFlow(rt: Runtime, target: Placed): Promise<void> {
  const { project } = target;
  const projects = fleetFor(rt).projects.filter((item) => item.id !== project.projectId);
  const unplaced = project.projectId === null && !project.ignored;
  const items: PickItem[] = [
    ...projects.map((item) => ({
      id: item.id,
      label: item.name,
      description: item.folder ?? 'project',
    })),
    { id: NEW_ID, label: NEW_LABEL, description: '' },
    ...(unplaced ? [{ id: IGNORE_ID, label: IGNORE_LABEL, description: '' }] : []),
  ];
  const picked = await rt.host.quickPick(items, `Move every session in ${project.folder} to`);
  if (picked === NEW_ID) {
    await createFor(rt, target);
  } else if (picked === IGNORE_ID) {
    await ignore(rt, target);
  } else if (picked !== null) {
    await assign(rt, target, picked);
  }
}

/** A session this window runs: in one of its terminals, in a tab it opened, or launched from it. */
function ownedHere(rt: Runtime, sessionId: string): boolean {
  return (
    rt.places.terminalFor(sessionId) !== null ||
    rt.sessionWorktrees.has(sessionId) ||
    rt.launcher.runs().some((run) => run.sessionId === sessionId)
  );
}

function isActive(session: SessionSummary): boolean {
  return session.state !== 'done' && session.state !== 'failed';
}

/** What each button on the question does. Dismissing it does nothing. */
const ANSWERS: Readonly<Record<string, (rt: Runtime, target: Placed) => Promise<void>>> = {
  [ADD_LABEL]: moveFlow,
  [NEW_LABEL]: createFor,
  [IGNORE_LABEL]: ignore,
};

async function askAbout(rt: Runtime, target: Placed): Promise<void> {
  const title = target.session.title === '' ? 'A session' : `"${target.session.title}"`;
  const answer = await rt.host.ask(
    `${title} runs in ${target.project.folder}, which is not in a project.`,
    [ADD_LABEL, NEW_LABEL, IGNORE_LABEL],
  );
  await ANSWERS[answer ?? '']?.(rt, target);
}

/**
 * Check the session folders, then ask once per folder about each live
 * session this window runs that is in no project. Other windows leave it to
 * the window that runs the session, so one session never asks twice.
 */
export async function checkProjects(rt: Runtime): Promise<void> {
  const { sessions } = fleetFor(rt);
  await rt.projects.refresh(sessions.map((session) => session.cwd));
  for (const session of sessions) {
    const project = session.cwd === '' ? null : rt.projects.resolve(session.cwd);
    if (
      project?.projectId !== null ||
      project.ignored ||
      !isActive(session) ||
      rt.projects.asked.has(project.folder) ||
      !ownedHere(rt, session.id)
    ) {
      continue;
    }
    rt.projects.asked.add(project.folder);
    askAbout(rt, { session, project }).catch((error: unknown) => {
      rt.report(SOURCE, messageOf(error));
    });
  }
}

/**
 * Load the projects, check the session folders now and every few seconds,
 * and load the projects again when another window changes them. Returns
 * what stops it all.
 */
export async function watchProjects(
  rt: Runtime,
  interval: IntervalFunction,
  fileWatch: FileWatchFunction,
): Promise<(() => void)[]> {
  await rt.projects.load();
  void checkProjects(rt);
  return [
    interval(() => {
      void checkProjects(rt);
    }, PROJECTS_REFRESH_MS),
    fileWatch(rt.projects.file, () => {
      void rt.projects.load();
    }),
  ];
}

function manualName(rt: Runtime, projectId: string): string | null {
  return rt.projects.book.projects.find((item) => item.id === projectId)?.name ?? null;
}

export const projectActions: ActionHandlers<ProjectActions> = {
  moveSession: async ({ rt }, action) => {
    const target = placed(rt, action.sessionId);
    if (target !== null) {
      await moveFlow(rt, target);
    }
  },
  newProject: async ({ rt }, action) => {
    const target = placed(rt, action.sessionId);
    if (target !== null) {
      await createFor(rt, target);
    }
  },
  renameProject: async ({ rt }, action) => {
    const current = manualName(rt, action.projectId);
    if (current === null) {
      rt.host.showInfo('Only a project made by hand can be renamed.');
      return;
    }
    const name = await askName(rt, current);
    if (name !== null && name !== current) {
      await rt.projects.update((book) => renameProject(book, action.projectId, name));
    }
  },
  deleteProject: async ({ rt }, action) => {
    const name = manualName(rt, action.projectId);
    if (name === null) {
      rt.host.showInfo('Only a project made by hand can be deleted.');
      return;
    }
    const message = `Delete the project "${name}"? Its sessions go back to their repository or to Unassigned.`;
    if (await rt.host.confirm(message, 'Delete')) {
      await rt.projects.update((book) => removeProject(book, action.projectId));
    }
  },
};
