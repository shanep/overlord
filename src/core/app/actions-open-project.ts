// Open a project without a session in it first: pick any project Overlord
// knows, or a folder, then start a session there, open it in its own
// window, or add it to this one. The New Session command asks the same way,
// with this window's folder first, and then, once Boise State is set up,
// whether the session runs on Claude Code's usual account or on the bridge.

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { ProjectSummary } from '../../shared/protocol.js';
import type { AgentTerminal } from '../agents/terminals.js';
import { needsBridge } from '../bridge/boisestate.js';
import { addProject, assignFolder, resolveProject, setProjectFolder } from '../projects/book.js';

import type { ActionHandlers } from './action-types.js';
import { askName, BROWSE_LABEL, chooseFolder, folderOf } from './actions-projects.js';
import { agentToStart } from './agent-terminal.js';
import type { PickItem } from './host-port.js';
import type { Runtime } from './runtime.js';
import { fleetFor } from './views/fleet.js';
import { newSession, STARTING } from './worktrees.js';

type OpenActions = 'openProject' | 'newProjectSession' | 'newSession' | 'newBridgeChat';

const BROWSE_ID = 'browse';
export const PICK_TITLE = 'Open a project';
export const NO_FOLDER = 'no folder yet';
export const SESSION_TITLE = 'Start a Claude Code session in';
export const HERE_ID = 'here';
export const BACKEND_TITLE = 'Run the session on';
export const CLAUDE_ID = 'claude';
export const BRIDGE_ID = 'boisestate';
const BACKENDS: readonly PickItem[] = [
  { id: CLAUDE_ID, label: 'Claude Code', description: 'your usual account' },
  {
    id: BRIDGE_ID,
    label: 'Boise State (Opus 5.5)',
    description: 'through the boisestate.ai bridge',
  },
];
const BROWSE_ITEM: PickItem = { id: BROWSE_ID, label: BROWSE_LABEL, description: '' };

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

/** The project or folder picked from a list that ends with Browse. */
async function targetOf(rt: Runtime, picked: string | null, title: string): Promise<Target | null> {
  if (picked === BROWSE_ID) {
    const folder = await rt.host.pickFolder(title);
    return folder === null ? null : fromFolder(rt, folder);
  }
  const project = fleetFor(rt).projects.find((item) => item.id === picked);
  return project === undefined ? null : known(rt, project);
}

async function pickTarget(rt: Runtime): Promise<Target | null> {
  const picked = await rt.host.quickPick([...(await projectItems(rt)), BROWSE_ITEM], PICK_TITLE);
  return targetOf(rt, picked, PICK_TITLE);
}

/** This window's folder, or home in a window with none, where a session started before it asked. */
function hereItem(rt: Runtime, here: string | null): PickItem {
  return here === null
    ? { id: HERE_ID, label: 'Home folder', description: rt.paths.home }
    : { id: HERE_ID, label: path.basename(here), description: `${here} (this window)` };
}

/** Asks where a new session should start, with this window's folder first. */
async function pickSessionFolder(rt: Runtime): Promise<string | null | undefined> {
  const here = rt.host.workspaceFolder();
  const root = here === null ? null : (rt.projects.rootOf(here) ?? here);
  const projects = await projectItems(rt);
  const others = projects.filter((item) => item.description !== root);
  const picked = await rt.host.quickPick(
    [hereItem(rt, here), ...others, BROWSE_ITEM],
    SESSION_TITLE,
  );
  if (picked === HERE_ID) {
    return here;
  }
  const target = await targetOf(rt, picked, SESSION_TITLE);
  return target?.folder;
}

/** True once Boise State is set up, which saving its key does by adding its profile. */
async function bridgeReady(rt: Runtime): Promise<boolean> {
  if (rt.host.resolveBridgeEnv === undefined) {
    return false;
  }
  await rt.caches.profiles.refresh();
  return rt.caches.profiles.peek().some((profile) => needsBridge(profile.env));
}

/** Whether the session runs on the bridge, asked only once Boise State is set up. Null when cancelled. */
async function pickBridge(rt: Runtime): Promise<boolean | null> {
  if (!(await bridgeReady(rt))) {
    return false;
  }
  const picked = await rt.host.quickPick(BACKENDS, BACKEND_TITLE);
  return picked === null ? null : picked === BRIDGE_ID;
}

async function startIn(
  rt: Runtime,
  folder: string | null,
  bridge = false,
  agent?: AgentTerminal,
): Promise<void> {
  const title = bridge || agent === undefined ? STARTING : `Starting ${agent.adapter.name}`;
  await rt.host.withProgress(title, async () => newSession(rt, folder, bridge, agent));
}

/** Starts a session in a folder, after asking where it runs. The bridge only serves Claude Code. */
async function askAndStart(
  rt: Runtime,
  folder: string | null,
  agent?: AgentTerminal,
): Promise<void> {
  const claude = agent === undefined || agent.adapter.id === CLAUDE_CODE;
  const bridge = claude ? await pickBridge(rt) : false;
  if (bridge !== null) {
    await startIn(rt, folder, bridge, agent);
  }
}

const OPENERS: Readonly<Record<Way, (rt: Runtime, folder: string) => Promise<void>>> = {
  session: askAndStart,
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
  // An agent id routes the start to that agent's terminal facet.
  newSession: async ({ rt }, action) => {
    const agent = agentToStart(rt, action.agent);
    if (agent === null) {
      return;
    }
    const folder = await pickSessionFolder(rt);
    if (folder !== undefined) {
      await askAndStart(rt, folder, agent);
    }
  },
  newProjectSession: async ({ rt }, action) => {
    const folder = await folderOf(rt, action.projectId);
    if (folder !== null) {
      await askAndStart(rt, folder);
    }
  },
  // The New Boise State Session command already says where the session runs.
  newBridgeChat: async ({ rt }) => {
    const folder = await pickSessionFolder(rt);
    if (folder !== undefined) {
      await startIn(rt, folder, true);
    }
  },
};
