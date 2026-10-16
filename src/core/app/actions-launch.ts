// Launcher and permission actions: run batches, stop runs, answer permission
// requests, and keep rules and profiles.

import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';
import { estimateBatch } from '../harness/estimate.js';
import { saveProfile } from '../knobs/profiles.js';
import { DEFAULT_PRICES } from '../transcripts/pricing.js';

import type { ActionHandlers } from './action-types.js';
import { DEFAULT_MODEL, formatUsd, toEstimatePrices } from './prices.js';
import type { Runtime } from './runtime.js';
import { parseRule, storagePath } from './storage.js';
import { plural } from './text.js';

type LaunchActions =
  | 'resolvePermission'
  | 'alwaysAllowPermission'
  | 'launch'
  | 'stopRun'
  | 'stopAll'
  | 'saveRule'
  | 'deleteRule'
  | 'saveProfile';

/** Batches estimated above this many dollars ask before they start. */
export const CONFIRM_ABOVE_USD = 1;

const ESTIMATE_PRICES = toEstimatePrices(DEFAULT_PRICES);

/** The model a run gets when its profile names none: the effective `model` setting, else the CLI default. */
export function defaultModel(rt: Runtime): string {
  const setting = rt.caches.knobs.peek().effective.find((item) => item.key === 'model');
  return typeof setting?.value === 'string' && setting.value !== '' ? setting.value : DEFAULT_MODEL;
}

/** Where a run works when the form leaves Folder empty: this window's folder, else home. */
export function launchFolder(rt: Runtime): string {
  return rt.host.workspaceFolder() ?? rt.paths.home;
}

async function freshProfiles(rt: Runtime): Promise<readonly LaunchProfile[]> {
  await rt.caches.profiles.refresh();
  return rt.caches.profiles.peek();
}

async function approveCost(
  rt: Runtime,
  specs: readonly LaunchSpec[],
  profiles: readonly LaunchProfile[],
): Promise<boolean> {
  const estimate = estimateBatch(specs, profiles, {
    prices: ESTIMATE_PRICES,
    defaultModel: defaultModel(rt),
  });
  if (estimate.totalUsd <= CONFIRM_ABOVE_USD) {
    return true;
  }
  const runs = plural(specs.length, 'run');
  return rt.host.confirm(
    `These ${runs} may cost about ${formatUsd(estimate.totalUsd)}. Launch them?`,
    'Launch',
  );
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
    const result = await saveProfile(storagePath(rt.host.storageDir, 'profiles'), action.profile);
    if (!result.ok) {
      rt.host.showError(result.error);
      return;
    }
    await rt.caches.profiles.refresh();
  },
};
