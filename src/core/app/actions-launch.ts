// Launcher and permission actions: run batches, stop runs, answer permission
// requests, and keep rules and profiles.

import path from 'node:path';

import type { AgentId } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';
import type { LaunchFolder } from '../../shared/protocol.js';
import { agents } from '../agents/index.js';
import { estimateBatch, type AgentPrices } from '../harness/estimate.js';
import { deleteProfile, modesLookup, saveProfile } from '../knobs/profiles.js';

import type { ActionHandlers } from './action-types.js';
import { DEFAULT_MODEL, formatUsd } from './prices.js';
import type { Runtime } from './runtime.js';
import { parseRule, storagePath } from './storage.js';
import { plural } from './text.js';
import { fleetFor } from './views/fleet.js';
import { knobsOf } from './views/knobs.js';

type LaunchActions =
  | 'resolvePermission'
  | 'alwaysAllowPermission'
  | 'launch'
  | 'stopRun'
  | 'stopAll'
  | 'browseLaunchFolder'
  | 'saveRule'
  | 'deleteRule'
  | 'saveProfile'
  | 'deleteProfile';

/** Batches estimated above this many dollars ask before they start. */
export const CONFIRM_ABOVE_USD = 1;

/** The model a run gets when its profile names none: the effective `model` setting, else the CLI default. */
export function defaultModel(rt: Runtime): string {
  const setting = knobsOf(rt.caches.knobs.peek()).effective.find((item) => item.key === 'model');
  return typeof setting?.value === 'string' && setting.value !== '' ? setting.value : DEFAULT_MODEL;
}

/** Where a run works when the form leaves Folder empty: this window's folder, else home. */
export function launchFolder(rt: Runtime): string {
  return rt.host.workspaceFolder() ?? rt.paths.home;
}

export const BROWSE_TITLE = 'Run in which folder?';

/**
 * The folders the form offers: this window's (or home), then the fleet's
 * projects by name, then the ones picked with Browse, each folder once.
 */
export function launchFolders(rt: Runtime): LaunchFolder[] {
  const here = rt.host.workspaceFolders();
  const projects = fleetFor(rt)
    .projects.flatMap((project) =>
      project.folder === null ? [] : [{ name: project.name, folder: project.folder }],
    )
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const all: LaunchFolder[] = [
    ...(here.length === 0
      ? [{ name: 'Home folder', folder: rt.paths.home, source: 'home' as const }]
      : here.map((folder) => ({ name: path.basename(folder), folder, source: 'window' as const }))),
    ...projects.map((project) => ({ ...project, source: 'project' as const })),
    ...rt.browsedFolders.map((item) => ({
      name: path.basename(item.folder),
      folder: item.folder,
      source: 'browsed' as const,
    })),
  ];
  const seen = new Set<string>();
  return all.filter((item) => {
    if (seen.has(item.folder)) {
      return false;
    }
    seen.add(item.folder);
    return true;
  });
}

async function freshProfiles(rt: Runtime): Promise<readonly LaunchProfile[]> {
  await rt.caches.profiles.refresh();
  return rt.caches.profiles.peek();
}

/** An unknown agent has no prices. The Launcher fails its runs before they cost anything. */
const NO_PRICES: AgentPrices = { price: () => null, defaultModel: '' };

/** What an agent's runs cost. Claude Code's default model follows its model setting. */
function pricesFor(rt: Runtime, agent: AgentId): AgentPrices {
  const models = agents.get(agent)?.models;
  if (models === undefined) {
    return NO_PRICES;
  }
  return {
    price: models.price,
    defaultModel: agent === CLAUDE_CODE ? defaultModel(rt) : models.defaultModel,
  };
}

/** The question before a costly batch, which says how many runs it could not price. */
function costQuestion(
  count: number,
  estimate: { readonly totalUsd: number; readonly unpricedRuns: number },
): string {
  const cost = `These ${plural(count, 'run')} may cost about ${formatUsd(estimate.totalUsd)}`;
  const unknown =
    estimate.unpricedRuns === 0
      ? ''
      : `, not counting ${String(estimate.unpricedRuns)} whose cost is unknown`;
  return `${cost}${unknown}. Launch them?`;
}

async function approveCost(
  rt: Runtime,
  specs: readonly LaunchSpec[],
  profiles: readonly LaunchProfile[],
): Promise<boolean> {
  const estimate = estimateBatch(specs, profiles, { pricesFor: (agent) => pricesFor(rt, agent) });
  if (estimate.totalUsd <= CONFIRM_ABOVE_USD) {
    return true;
  }
  return rt.host.confirm(costQuestion(specs.length, estimate), 'Launch');
}

export const launchActions: ActionHandlers<LaunchActions> = {
  resolvePermission: async ({ rt }, action) => {
    if (!rt.permissions.resolve(action.requestId, action.decision)) {
      rt.host.showInfo('That request is no longer waiting.');
    }
    await Promise.resolve();
  },
  alwaysAllowPermission: async ({ rt }, action) => {
    const outcome = await rt.permissions.alwaysAllow(action.requestId);
    if (outcome === 'gone') {
      rt.host.showInfo('That request is no longer waiting.');
    } else if (outcome === 'once') {
      rt.host.showInfo(
        'Allowed once. Overlord only remembers a plain command, with no chaining, pipes, redirects or backslashes, so this one will ask again.',
      );
    }
  },
  launch: async ({ rt }, action) => {
    if (action.specs.length === 0) {
      rt.host.showInfo('Nothing to launch.');
      return;
    }
    const folder = launchFolder(rt);
    const specs = action.specs.map((spec) => (spec.cwd === '' ? { ...spec, cwd: folder } : spec));
    const profiles = await freshProfiles(rt);
    if (!(await approveCost(rt, specs, profiles))) {
      return;
    }
    rt.launcher.launch(specs, profiles);
    rt.host.showInfo(`Queued ${plural(specs.length, 'run')}.`);
  },
  stopRun: async ({ rt }, action) => {
    if (!rt.launcher.stopRun(action.runId)) {
      rt.host.showInfo('That run already finished.');
    }
    await Promise.resolve();
  },
  stopAll: async ({ rt }) => {
    const stopped = rt.launcher.stopAll();
    rt.host.showInfo(stopped === 0 ? 'Nothing is running.' : `Stopped ${plural(stopped, 'run')}.`);
    await Promise.resolve();
  },
  browseLaunchFolder: async ({ rt }) => {
    const folder = await rt.host.pickFolder(BROWSE_TITLE);
    if (folder === null) {
      return;
    }
    const rest = rt.browsedFolders.filter((item) => item.folder !== folder);
    rt.browsedFolders.splice(0, rt.browsedFolders.length, { folder, at: rt.clock() }, ...rest);
    rt.notify();
  },
  saveRule: async ({ rt }, action) => {
    const rule = parseRule(action.rule);
    if (rule === null) {
      rt.host.showError('That rule is not valid.');
      return;
    }
    await rt.permissions.saveRule(rule);
  },
  deleteRule: async ({ rt }, action) => {
    if (!(await rt.permissions.deleteRule(action.ruleId))) {
      rt.host.showInfo('That rule is already gone.');
    }
  },
  saveProfile: async ({ rt }, action) => {
    const file = storagePath(rt.host.storageDir, 'profiles');
    const result = await saveProfile(file, action.profile, modesLookup(agents.list()));
    if (!result.ok) {
      rt.host.showError(result.error);
      return;
    }
    await rt.caches.profiles.refresh();
  },
  deleteProfile: async ({ rt }, action) => {
    const profile = rt.caches.profiles.peek().find((item) => item.id === action.profileId);
    const name = profile?.name ?? 'this profile';
    if (!(await rt.host.confirm(`Delete the launch profile ${name}?`, 'Delete'))) {
      return;
    }
    const result = await deleteProfile(
      storagePath(rt.host.storageDir, 'profiles'),
      action.profileId,
    );
    if (!result.ok) {
      rt.host.showError(result.error);
      return;
    }
    await rt.caches.profiles.refresh();
  },
};
