// Actions that change config on disk: settings knobs, the claude.ai import,
// config repo push and pull, and adopting a local item into the repo.

import { z } from 'zod';

import type { AgentId } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import { claudeKnobs } from '../agents/claude/config.js';
import { agents } from '../agents/index.js';
import { findKnob } from '../knobs/catalog.js';
import type { KnobsFacet, SettingsFormat } from '../knobs/facet.js';
import type { JsonValue } from '../knobs/json.js';
import { writeSetting } from '../knobs/write.js';
import { importClaudeAiExport } from '../surfaces/claude-ai-export.js';
import { applyPlan } from '../sync/apply.js';

import type { ActionHandlers, ActionMap } from './action-types.js';
import { canAdopt, planAdoptItem } from './adopt.js';
import { applyDeps, reportApply } from './apply-plan.js';
import type { Runtime } from './runtime.js';
import { storagePath, writeImport } from './storage.js';
import { NOT_CONNECTED, SyncCommands } from './sync-commands.js';
import { syncTargets } from './sync-targets.js';
import { plural } from './text.js';
import { configRepoDir, connectedRoot } from './views/config.js';
import { knobsFacet } from './views/knobs.js';
import { trackAdviceTaken } from './views/tuning.js';

type ConfigActions =
  | 'setKnob'
  | 'openKnobDocs'
  | 'pickKnobsAgent'
  | 'importClaudeAi'
  | 'syncPush'
  | 'syncPull'
  | 'turnOnSync'
  | 'syncNow'
  | 'adoptConfig';

type Layer = ActionMap['setKnob']['layer'];

const jsonSchema = z.json();

/**
 * The settings key path for a catalog key: env vars live under the agent's
 * env block, and CLI flags (or env vars an agent's settings cannot set) are
 * not settings.
 */
export function settingsKeyPath(key: string, knobs: KnobsFacet = claudeKnobs): string | null {
  const matches = knobs.catalog().filter((knob) => knob.key === key);
  if (matches.length === 0 || matches.some((knob) => knob.kind === 'setting')) {
    return key;
  }
  const isEnv = matches.some((knob) => knob.kind === 'env');
  return isEnv && knobs.envBlock !== null ? `${knobs.envBlock}.${key}` : null;
}

interface LayerTarget {
  readonly file: string;
  readonly format: SettingsFormat;
}

/** The settings file for a layer, or null when the layer needs a workspace and none is open. */
export function layerFile(
  rt: Runtime,
  layer: Layer,
  knobs: KnobsFacet = claudeKnobs,
): LayerTarget | null {
  const source = knobs.layers.find((item) => item.layer === layer);
  if (source?.kind !== 'file' || !source.writable) {
    return null;
  }
  const place = { paths: rt.paths, projectDir: rt.host.workspaceFolder(), env: rt.env };
  const file = source.file(place);
  return file === null ? null : { file, format: source.format };
}

/** The agent's name for a message, or its id when no adapter has it. */
function agentName(agent: AgentId | undefined): string {
  const id = agent ?? CLAUDE_CODE;
  return agents.get(id)?.name ?? id;
}

/** Null means remove the key. Anything else must be plain JSON. */
function toJson(value: unknown): { readonly ok: boolean; readonly value: JsonValue | undefined } {
  if (value === null || value === undefined) {
    return { ok: true, value: undefined };
  }
  const parsed = jsonSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, value: undefined };
}

async function adopt(rt: Runtime, itemId: string): Promise<void> {
  await rt.caches.config.refresh();
  const item = rt.caches.config.peek().items.find((candidate) => candidate.id === itemId);
  if (item === undefined || !canAdopt(item)) {
    rt.host.showInfo('Only local-only items can be adopted.');
    return;
  }
  const root = await connectedRoot(
    rt.exec,
    configRepoDir(rt.host.settings.configRepoPath, rt.paths.home),
  );
  if (root === null) {
    rt.host.showInfo(NOT_CONNECTED);
    return;
  }
  const input = {
    repoRoot: root,
    item,
    paths: rt.paths,
    agents: syncTargets(rt),
    host: rt.hostname,
  };
  const plan = await planAdoptItem(input);
  if (!plan.ok) {
    if (plan.unsupported) {
      rt.host.showInfo(plan.reason);
    } else {
      rt.host.showError(plan.reason);
    }
    return;
  }
  if (!(await rt.host.confirm(plan.question, 'Adopt'))) {
    return;
  }
  reportApply(rt, await applyPlan(plan.actions, applyDeps(rt)));
  await rt.caches.config.refresh();
}

export const configActions: ActionHandlers<ConfigActions> = {
  setKnob: async ({ rt }, action) => {
    const knobs = knobsFacet(agents, action.agent);
    if (knobs === null) {
      rt.host.showError(`${agentName(action.agent)} has no settings Overlord can change.`);
      return;
    }
    const keyPath = settingsKeyPath(action.key, knobs);
    const target = layerFile(rt, action.layer, knobs);
    const json = toJson(action.value);
    if (keyPath === null) {
      rt.host.showInfo(`${action.key} is a CLI flag. Add it to a launch profile instead.`);
    } else if (target === null) {
      rt.host.showInfo('Open a folder to change project settings.');
    } else if (json.ok) {
      const result = await writeSetting({ ...target, keyPath, value: json.value });
      if (!result.ok) {
        rt.host.showError(result.error);
        return;
      }
      await rt.caches.knobs.refresh();
      rt.context.clear();
      // An unset knob comes through as undefined, and clearing one is not taking advice.
      // Tuning's advice names Claude Code's keys, so another agent's key of the same name is not it.
      if (json.value !== undefined && (action.agent ?? CLAUDE_CODE) === CLAUDE_CODE) {
        await trackAdviceTaken(rt, { kind: 'knob', key: action.key });
      }
    } else {
      rt.host.showError(`The value for ${action.key} is not plain JSON.`);
    }
  },
  openKnobDocs: async ({ rt }, action) => {
    // Only catalog doc links open, so a webview can never send the browser anywhere else.
    const knob = findKnob(
      knobsFacet(agents, action.agent)?.catalog() ?? [],
      action.kind,
      action.key,
    );
    if (knob === undefined) {
      rt.host.showInfo(`No docs page is known for ${action.key}.`);
      return;
    }
    await rt.host.openExternal(knob.docUrl);
  },
  pickKnobsAgent: async ({ rt }, action) => {
    if (knobsFacet(agents, action.agent) === null) {
      rt.host.showInfo(`${agentName(action.agent)} has no knobs to show.`);
      return;
    }
    rt.knobsPick.agent = action.agent;
    rt.notify();
    await Promise.resolve();
  },
  importClaudeAi: async ({ rt }) => {
    const picked = await rt.host.pickFile({
      title: 'Pick conversations.json or the unzipped claude.ai export folder',
      filters: { JSON: ['json'] },
    });
    if (picked === null) {
      return;
    }
    const result = await importClaudeAiExport(picked, { now: rt.clock });
    const first = result.errors[0];
    if (result.conversations.length === 0 && first !== undefined) {
      rt.host.showError(`Import failed: ${first.message}`);
      return;
    }
    await writeImport(storagePath(rt.host.storageDir, 'claudeAi'), {
      importedAt: result.importedAt,
      sessions: result.conversations.map((conversation) => conversation.session),
    });
    rt.host.showInfo(`Imported ${plural(result.conversations.length, 'chat')}.`);
    await rt.caches.sessions.refresh();
  },
  syncPush: async ({ rt }) => {
    await new SyncCommands(rt).push();
  },
  syncPull: async ({ rt }) => {
    await new SyncCommands(rt).pull();
  },
  turnOnSync: async ({ rt }) => {
    await new SyncCommands(rt).turnOn();
  },
  syncNow: async ({ rt }) => {
    await rt.configSync.syncNow();
  },
  adoptConfig: async ({ rt }, action) => {
    await adopt(rt, action.itemId);
  },
};
