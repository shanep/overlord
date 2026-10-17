// Where a new agent or skill is saved, and the save itself. A skill can go in
// any folder an agent in play reads, and the pick names the agents that read
// each one. An agent goes in the folders of the agent it is for, in that
// agent's format.

import path from 'node:path';

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentFilesFacet, LibraryPlace } from '../agents/types.js';
import { agentFileIn, skillFileIn } from '../authoring/folders.js';
import type { LibraryReader } from '../authoring/library.js';
import { foldersOf, readersOf } from '../authoring/library.js';
import type { AuthoringKind } from '../authoring/schema.js';
import { validateAgentFile, validateSkillFile } from '../authoring/validate.js';
import type { AuthoringScope, TargetDirs } from '../authoring/write.js';
import { targetPath, writeAuthoredFile } from '../authoring/write.js';
import { applyPlan } from '../sync/apply.js';
import { LAYOUT, repoFile } from '../sync/layout.js';

import type { ActionHandlers } from './action-types.js';
import { manifestItemFor, planLinkBack } from './adopt.js';
import { applyDeps } from './apply-plan.js';
import type { AuthoringTarget } from './authoring.js';
import { authoredText, pickAuthoringTarget } from './authoring.js';
import type { PickItem } from './host-port.js';
import { libraryPlace } from './library-scan.js';
import type { Runtime } from './runtime.js';
import { configRepoDir, connectedRoot } from './views/config.js';

export interface Destination {
  readonly scope: AuthoringScope;
  readonly dirs: TargetDirs;
  /** The config repo root when a user scope file goes into the repo. */
  readonly repoRoot: string | null;
  /** A folder past Claude Code's own scopes, like .agents/skills, or null for those. */
  readonly folder: string | null;
}

/** What the pick offers: the agents in play and the one a new agent is for. */
export interface DestinationFor {
  readonly kind: AuthoringKind;
  readonly target: AuthoringTarget;
}

const FOLDER_ID = 'folder:';

function names(readers: readonly LibraryReader[]): string {
  const shorts = readers.map((reader) => reader.short);
  return shorts.length <= 1
    ? (shorts[0] ?? '')
    : `${shorts.slice(0, -1).join(', ')} and ${shorts.at(-1) ?? ''}`;
}

/** A path under home as ~/..., and one under the workspace relative to it. */
function shown(dir: string, home: string, workspace: string | null): string {
  if (workspace !== null && dir.startsWith(`${workspace}${path.sep}`)) {
    return path.relative(workspace, dir);
  }
  return dir.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, dir)}` : dir;
}

function scopeItems(repoRoot: string | null, workspace: string | null): PickItem[] {
  const user: PickItem = {
    id: 'user',
    label: 'User',
    description:
      repoRoot === null ? 'Saved in ~/.claude' : 'Saved in the config repo, linked into ~/.claude',
  };
  const project: PickItem[] =
    workspace === null
      ? []
      : [{ id: 'project', label: 'Project', description: `Saved in ${workspace}/.claude` }];
  return [
    user,
    ...project,
    { id: 'plugin', label: 'Plugin', description: 'Saved in a plugin folder you pick' },
  ];
}

/** A folder past Claude Code's own scopes, with the agents that read it. */
interface FolderChoice {
  readonly dir: string;
  readonly scope: AuthoringScope;
  readonly readBy: readonly LibraryReader[];
}

/** Claude Code's own scope items, each naming who reads it once another agent is in play. */
function claudeItems(
  rt: Runtime,
  options: DestinationFor,
  place: LibraryPlace,
  repoRoot: string | null,
): PickItem[] {
  const workspace = place.cwd;
  const base = scopeItems(repoRoot, workspace);
  const { readers } = options.target;
  if (options.kind !== 'skill' || readers.length <= 1) {
    return base;
  }
  const others = readers.filter((reader) => reader.id !== CLAUDE_CODE);
  const claude = readers.filter((reader) => reader.id === CLAUDE_CODE);
  const dirFor: Readonly<Record<string, string | null>> = {
    user: rt.paths.userSkillsDir,
    project: workspace === null ? null : path.join(workspace, '.claude', 'skills'),
    plugin: null,
  };
  return base.map((item) => {
    const dir = dirFor[item.id] ?? null;
    const also = dir === null ? [] : readersOf(others, 'skill', place, dir);
    return { ...item, description: `${item.description}. Read by ${names([...claude, ...also])}.` };
  });
}

/** Claude Code's skill folders, which its own scope items already offer. */
function claudeSkillDirs(rt: Runtime, place: LibraryPlace): Set<string> {
  const dirs = [rt.paths.userSkillsDir];
  if (place.cwd !== null) {
    dirs.push(path.join(place.cwd, '.claude', 'skills'));
  }
  return new Set(dirs.map((dir) => path.resolve(dir)));
}

/** Folders past Claude Code's own: for a skill, any another agent reads, and for an agent, its own. */
function folderChoices(rt: Runtime, options: DestinationFor, place: LibraryPlace): FolderChoice[] {
  const { kind, target } = options;
  const skip = kind === 'skill' ? claudeSkillDirs(rt, place) : new Set<string>();
  const writers = (kind === 'agent' ? [target.reader] : target.readers).filter(
    (reader) => reader.id !== CLAUDE_CODE,
  );
  const found = writers.flatMap((reader) =>
    foldersOf(reader, kind, place)
      .filter((folder) => folder.writable)
      .map((folder) => ({ reader, folder, dir: path.resolve(folder.dir) })),
  );
  const choices = new Map<string, FolderChoice>();
  for (const { reader, folder, dir } of found.filter((one) => !skip.has(one.dir))) {
    if (!choices.has(dir)) {
      const readBy = kind === 'skill' ? readersOf(target.readers, kind, place, dir) : [reader];
      choices.set(dir, { dir, scope: folder.scope === 'project' ? 'project' : 'user', readBy });
    }
  }
  return [...choices.values()];
}

function folderItem(rt: Runtime, place: LibraryPlace, choice: FolderChoice): PickItem {
  const where = choice.scope === 'project' ? 'Project' : 'User';
  return {
    id: `${FOLDER_ID}${choice.dir}`,
    label: `${where}: ${shown(choice.dir, rt.paths.home, place.cwd)}`,
    description: `Read by ${names(choice.readBy)}`,
  };
}

/** The items for Claude Code's own scopes, or none for a new agent of another agent. */
function ownItems(
  rt: Runtime,
  options: DestinationFor | null,
  place: LibraryPlace,
  repoRoot: string | null,
): PickItem[] {
  if (options === null) {
    return scopeItems(repoRoot, place.cwd);
  }
  return options.target.reader.id === CLAUDE_CODE ? claudeItems(rt, options, place, repoRoot) : [];
}

/** Where a pick of user, project or plugin puts the file. Null when the user backed out. */
async function claudeDestination(
  rt: Runtime,
  scope: string | null,
  repoRoot: string | null,
  workspace: string | null,
): Promise<Destination | null> {
  if (scope === 'user') {
    const paths =
      repoRoot === null
        ? rt.paths
        : {
            userAgentsDir: repoFile(repoRoot, LAYOUT.agents),
            userSkillsDir: repoFile(repoRoot, LAYOUT.skills),
          };
    return { scope, dirs: { paths }, repoRoot, folder: null };
  }
  if (scope === 'project' && workspace !== null) {
    return {
      scope,
      dirs: { paths: rt.paths, projectDir: workspace },
      repoRoot: null,
      folder: null,
    };
  }
  if (scope !== 'plugin') {
    return null;
  }
  const pluginDir = await rt.host.pickFolder('Pick the plugin folder');
  return pluginDir === null
    ? null
    : { scope, dirs: { paths: rt.paths, pluginDir }, repoRoot: null, folder: null };
}

/**
 * Asks whether the file goes in user, project or plugin scope, or in a folder
 * of another agent. Without options only Claude Code's scopes are offered.
 * Null when the user backed out.
 */
export async function pickDestination(
  rt: Runtime,
  options: DestinationFor | null = null,
): Promise<Destination | null> {
  const workspace = rt.host.workspaceFolder();
  // Saving offers the workspace's own folders, not the ones above it.
  const place = libraryPlace(rt, workspace, null);
  const forClaude = options === null || options.target.reader.id === CLAUDE_CODE;
  const repoRoot = forClaude
    ? await connectedRoot(rt.exec, configRepoDir(rt.host.settings.configRepoPath, rt.paths.home))
    : null;
  const choices = options === null ? [] : folderChoices(rt, options, place);
  const items = [
    ...ownItems(rt, options, place, repoRoot),
    ...choices.map((choice) => folderItem(rt, place, choice)),
  ];
  const scope = await rt.host.quickPick(items, 'Save it where?');
  const picked = choices.find((choice) => `${FOLDER_ID}${choice.dir}` === scope);
  if (picked !== undefined) {
    return { scope: picked.scope, dirs: { paths: rt.paths }, repoRoot: null, folder: picked.dir };
  }
  return claudeDestination(rt, scope, repoRoot, workspace);
}

/** The file a new skill or agent named name goes to. */
export function destinationFile(
  kind: AuthoringKind,
  destination: Destination,
  name: string,
  agentFiles: Pick<AgentFilesFacet, 'suffix'> | null = null,
): string {
  const { folder } = destination;
  if (folder === null) {
    return targetPath(kind, destination.scope, name, destination.dirs);
  }
  return kind === 'skill'
    ? skillFileIn(folder, name)
    : agentFileIn(folder, name, agentFiles?.suffix ?? '.md');
}

/** Links a user scope file written into the config repo back into ~/.claude. */
export async function linkIntoClaude(
  rt: Runtime,
  kind: AuthoringKind,
  name: string,
  repoRoot: string,
): Promise<void> {
  const file = targetPath(kind, 'user', name, { paths: rt.paths });
  const target = kind === 'agent' ? file : path.dirname(file);
  const item = manifestItemFor({ kind, scope: 'user', path: target }, rt.paths);
  if (item === null) {
    rt.host.showWarning(`Saved in the config repo, but it could not be linked into ${target}.`);
    return;
  }
  const result = await applyPlan(await planLinkBack(repoRoot, item, target), applyDeps(rt));
  if (result.failed !== null) {
    rt.host.showWarning(`Saved in the config repo, but linking failed: ${result.failed.message}`);
  }
}

function checkText(
  rt: Runtime,
  kind: AuthoringKind,
  text: string,
  agentFiles: AgentFilesFacet | undefined,
): void {
  const issues =
    kind === 'agent'
      ? (agentFiles?.validate(text) ?? validateAgentFile(text))
      : validateSkillFile(text);
  const error = issues.find((issue) => issue.severity === 'error');
  if (error !== undefined) {
    rt.host.showWarning(`Check the new file: ${error.message}`);
  }
}

/**
 * Asks where the file goes, writes it, links it into ~/.claude when needed
 * and opens it. Without a target only Claude Code's scopes are offered.
 * False when the user backed out.
 */
export async function saveAuthored(
  rt: Runtime,
  kind: AuthoringKind,
  authored: { readonly name: string; readonly text: string },
  target: AuthoringTarget | null = null,
): Promise<boolean> {
  const destination = await pickDestination(rt, target === null ? null : { kind, target });
  if (destination === null) {
    return false;
  }
  // Without a target the file is Claude Code's, in its own scopes.
  const agentFiles = target?.reader.library.agents;
  checkText(rt, kind, authored.text, agentFiles);
  const file = destinationFile(kind, destination, authored.name, agentFiles ?? null);
  let written = await writeAuthoredFile(file, authored.text, false);
  if (!written.ok) {
    if (!(await rt.host.confirm(`${written.path} already exists. Replace it?`, 'Replace'))) {
      return false;
    }
    written = await writeAuthoredFile(file, authored.text, true);
  }
  if (destination.repoRoot !== null) {
    await linkIntoClaude(rt, kind, authored.name, destination.repoRoot);
  }
  await rt.host.openFile(written.path);
  await Promise.all([rt.caches.config.refresh(), rt.caches.library.refresh()]);
  return true;
}

/** New skill or New agent, start to finish. */
export async function createAuthored(
  rt: Runtime,
  kind: AuthoringKind,
  registry?: AgentRegistry,
): Promise<void> {
  const target = await pickAuthoringTarget(rt, kind, registry);
  if (target === null) {
    return;
  }
  const authored = await authoredText(rt, kind, target);
  if (authored !== null) {
    await saveAuthored(rt, kind, authored, target);
  }
}

export const authoringActions: ActionHandlers<'newAgent' | 'newSkill'> = {
  newAgent: async ({ rt }) => {
    await createAuthored(rt, 'agent');
  },
  newSkill: async ({ rt }) => {
    await createAuthored(rt, 'skill');
  },
};
