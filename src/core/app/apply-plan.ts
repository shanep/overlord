// Shows a sync plan as a dry run, asks, and applies it. The dry run goes to a
// text file in storage and opens in the editor, since a plan can run to many
// lines.

import { writeFileAtomic } from '../knobs/atomic-file.js';
import type { Action } from '../sync/actions.js';
import { describeAction, summarizePlan } from '../sync/actions.js';
import type { AgentMcp, ApplyDeps, ApplyResult } from '../sync/apply.js';
import { applyPlan } from '../sync/apply.js';
import { collapseHome } from '../sync/layout.js';

import { mcpAgent, mcpCli } from './actions-connectors.js';
import type { Runtime } from './runtime.js';
import { storagePath } from './storage.js';
import { plural } from './text.js';

export function applyDeps(rt: Runtime): ApplyDeps {
  return {
    exec: rt.exec,
    secrets: rt.host.secrets,
    paths: rt.paths,
    now: () => new Date(rt.clock()),
    platform: rt.platform,
    mcp: async (agent): Promise<AgentMcp> => {
      const { adapter, store } = mcpAgent(agent);
      return { store, cli: await mcpCli(rt, adapter) };
    },
  };
}

export function changeCount(actions: readonly Action[]): number {
  return actions.filter((action) => action.kind !== 'note').length;
}

/** Tells the user how an apply went. True when every action ran. */
export function reportApply(rt: Runtime, result: ApplyResult): boolean {
  const home = rt.paths.home;
  if (result.failed !== null) {
    const step = describeAction(result.failed.action, home).replaceAll(/\s+/gu, ' ');
    rt.host.showError(`Stopped at "${step}": ${result.failed.message}`);
    return false;
  }
  const backup =
    result.backupDir === null ? '' : ` Backup in ${collapseHome(result.backupDir, home)}.`;
  rt.host.showInfo(`Applied ${plural(changeCount(result.performed), 'change')}.${backup}`);
  return true;
}

/** Opens the dry run, asks, and applies. Null when there was nothing to do or the user said no. */
export async function confirmAndApply(
  rt: Runtime,
  actions: readonly Action[],
  extra: readonly string[],
): Promise<ApplyResult | null> {
  const changes = changeCount(actions);
  if (changes === 0) {
    rt.host.showInfo('Nothing to change.');
    return null;
  }
  const file = storagePath(rt.host.storageDir, 'dryRun');
  const text = [summarizePlan(actions, rt.paths.home), ...extra].join('\n');
  await writeFileAtomic({ target: file, content: text, backup: null });
  await rt.host.openFile(file);
  const question = `Apply the ${plural(changes, 'change')} shown in the dry run?`;
  if (!(await rt.host.confirm(question, 'Apply'))) {
    return null;
  }
  const result = await applyPlan(actions, applyDeps(rt));
  reportApply(rt, result);
  return result;
}
