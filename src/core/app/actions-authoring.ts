// Where a new agent or skill is saved, and the save itself.

import path from 'node:path';

import type { AuthoringKind } from '../authoring/schema.js';
import { validateAgentFile, validateSkillFile } from '../authoring/validate.js';
import type { AuthoringScope, TargetDirs } from '../authoring/write.js';
import { targetPath, writeAuthored } from '../authoring/write.js';
import { applyPlan } from '../sync/apply.js';
import { LAYOUT, repoFile } from '../sync/layout.js';

import type { ActionHandlers } from './action-types.js';
import { manifestItemFor, planLinkBack } from './adopt.js';
import { applyDeps } from './apply-plan.js';
import { authoredText } from './authoring.js';
import type { PickItem } from './host-port.js';
import type { Runtime } from './runtime.js';
import { configRepoDir, connectedRoot } from './views/config.js';

export interface Destination {
  readonly scope: AuthoringScope;
  readonly dirs: TargetDirs;
  /** The config repo root when a user scope file goes into the repo. */
  readonly repoRoot: string | null;
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

/** Asks whether the file goes in user, project or plugin scope. Null when the user backed out. */
export async function pickDestination(rt: Runtime): Promise<Destination | null> {
  const repoRoot = await connectedRoot(
    rt.exec,
    configRepoDir(rt.host.settings.configRepoPath, rt.paths.home),
  );
  const workspace = rt.host.workspaceFolder();
  const scope = await rt.host.quickPick(scopeItems(repoRoot, workspace), 'Save it where?');
  if (scope === 'user') {
    const paths =
      repoRoot === null
        ? rt.paths
        : {
            userAgentsDir: repoFile(repoRoot, LAYOUT.agents),
            userSkillsDir: repoFile(repoRoot, LAYOUT.skills),
          };
    return { scope, dirs: { paths }, repoRoot };
  }
  if (scope === 'project' && workspace !== null) {
    return { scope, dirs: { paths: rt.paths, projectDir: workspace }, repoRoot: null };
  }
  if (scope !== 'plugin') {
    return null;
  }
  const pluginDir = await rt.host.pickFolder('Pick the plugin folder');
  return pluginDir === null
    ? null
    : { scope, dirs: { paths: rt.paths, pluginDir }, repoRoot: null };
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

function checkText(rt: Runtime, kind: AuthoringKind, text: string): void {
  const issues = kind === 'agent' ? validateAgentFile(text) : validateSkillFile(text);
  const error = issues.find((issue) => issue.severity === 'error');
  if (error !== undefined) {
    rt.host.showWarning(`Check the new file: ${error.message}`);
  }
}

/** Asks where the file goes, writes it, links it into ~/.claude when needed and opens it. False when the user backed out. */
export async function saveAuthored(
  rt: Runtime,
  kind: AuthoringKind,
  authored: { readonly name: string; readonly text: string },
): Promise<boolean> {
  const destination = await pickDestination(rt);
  if (destination === null) {
    return false;
  }
  checkText(rt, kind, authored.text);
  const request = {
    ...destination.dirs,
    kind,
    scope: destination.scope,
    name: authored.name,
    text: authored.text,
  };
  let written = await writeAuthored(request);
  if (!written.ok) {
    if (!(await rt.host.confirm(`${written.path} already exists. Replace it?`, 'Replace'))) {
      return false;
    }
    written = await writeAuthored({ ...request, overwrite: true });
  }
  if (destination.repoRoot !== null) {
    await linkIntoClaude(rt, kind, authored.name, destination.repoRoot);
  }
  await rt.host.openFile(written.path);
  await rt.caches.config.refresh();
  return true;
}

async function createAuthored(rt: Runtime, kind: AuthoringKind): Promise<void> {
  const authored = await authoredText(rt, kind);
  if (authored !== null) {
    await saveAuthored(rt, kind, authored);
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
