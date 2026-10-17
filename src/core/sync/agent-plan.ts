// The apply plan for each agent past Claude Code, from its agents/<id>/
// overlord.json. Files and folders link or copy the way Claude's do, settings
// are set key by key, and MCP servers go through the agent's MCP store.

import path from 'node:path';

import type { AgentId } from '../../shared/agents.js';
import type { AgentAdapter, ShellEnv, SyncFacet } from '../agents/types.js';

import type { Action } from './actions.js';
import { readAgentManifest, type AgentManifest } from './agent-manifest.js';
import { serverCore } from './agent-mcp.js';
import { changedEntries, readSettings, entriesToSync } from './agent-settings.js';
import { isDeniedAgentPath } from './denylist.js';
import { readJsonOrUndefined, statOrNull } from './files.js';
import { agentMachineSettingsPath, collapseHome, repoFile } from './layout.js';
import { readMcpFile } from './mcp.js';
import { matchesTemplate, planCopy, planLink, prepareTarget } from './plan-steps.js';
import { generateSettings } from './settings-gen.js';

/** An agent that syncs, with its folder on this machine. */
export interface AgentSyncTarget {
  readonly agent: AgentId;
  /** "Codex CLI", for README text and notices. */
  readonly name: string;
  /** "Codex", for the dry run. */
  readonly short: string;
  readonly sync: SyncFacet;
  /** The agent's folder here, with $CODEX_HOME or $COPILOT_HOME applied. */
  readonly dir: string;
  /** False when the adapter has no MCP store to add servers through. */
  readonly mcpStore: boolean;
}

/** Every adapter with a sync facet, pointed at this machine's folders. */
export function agentSyncTargets(
  adapters: readonly AgentAdapter[],
  home: string,
  env: ShellEnv,
): AgentSyncTarget[] {
  return adapters.flatMap((adapter) => {
    const sync = adapter.config?.sync;
    return sync === undefined
      ? []
      : [
          {
            agent: adapter.id,
            name: adapter.name,
            short: adapter.short,
            sync,
            dir: sync.dir(home, env),
            mcpStore: adapter.config?.mcp !== undefined,
          },
        ];
  });
}

/** The file or folder in the agent's folder for a target written with forward slashes. */
export function agentPath(target: AgentSyncTarget, relative: string): string {
  return path.join(target.dir, ...relative.split('/'));
}

/** Backups of another agent's files go in a folder named for the agent. */
function tagBackups(actions: readonly Action[], agent: AgentId): Action[] {
  return actions.map((action) => (action.kind === 'backup' ? { ...action, agent } : action));
}

async function planItems(
  target: AgentSyncTarget,
  manifest: AgentManifest,
  repoRoot: string,
): Promise<Action[]> {
  const actions: Action[] = [];
  for (const item of manifest.items) {
    const source = repoFile(repoRoot, item.source);
    const destination = agentPath(target, item.target);
    if (isDeniedAgentPath(destination, target.dir)) {
      actions.push({
        kind: 'note',
        message: `${target.short} ${item.id}: ${item.target} never syncs`,
      });
    } else if ((await statOrNull(source)) === null) {
      actions.push({
        kind: 'note',
        message: `${target.short} ${item.id}: ${item.source} is missing from the config repo`,
      });
    } else {
      const planned =
        item.mode === 'link'
          ? await planLink(source, destination)
          : await planCopy(source, destination);
      actions.push(...tagBackups(planned, target.agent));
    }
  }
  return actions;
}

async function planSettings(
  target: AgentSyncTarget,
  manifest: AgentManifest,
  repoRoot: string,
  host: string,
): Promise<Action[]> {
  const spec = target.sync.settings;
  if (spec === null || manifest.settings === null) {
    return [];
  }
  const generated = generateSettings(
    await readJsonOrUndefined(repoFile(repoRoot, manifest.settings)),
    await readJsonOrUndefined(repoFile(repoRoot, agentMachineSettingsPath(target.agent, host))),
  );
  const file = agentPath(target, spec.file);
  const live = await readSettings(file, spec.format);
  if (!live.ok) {
    return [
      { kind: 'note', message: `${target.short}: ${spec.file} could not be read (${live.error})` },
    ];
  }
  const entries = changedEntries(entriesToSync(generated, spec), live.value);
  if (entries.length === 0) {
    return [];
  }
  return [
    ...tagBackups(await prepareTarget(file), target.agent),
    { kind: 'set-keys', agent: target.agent, target: file, format: spec.format, entries },
  ];
}

async function planMcp(
  target: AgentSyncTarget,
  manifest: AgentManifest,
  repoRoot: string,
): Promise<Action[]> {
  const spec = target.sync.mcp;
  if (spec === null || manifest.mcp === null) {
    return [];
  }
  if (!target.mcpStore) {
    return [
      { kind: 'note', message: `${target.short}: Overlord cannot add MCP servers to it yet` },
    ];
  }
  const wanted = await readMcpFile(repoFile(repoRoot, manifest.mcp));
  const servers = await spec.read(target.dir);
  const live = new Map(servers.map((server) => [server.name, server.config]));
  const { agent, short } = target;
  const actions: Action[] = [];
  for (const server of wanted) {
    const existing = live.get(server.name);
    const core = serverCore(server.config);
    if (existing !== undefined && matchesTemplate(core, serverCore(existing))) {
      continue;
    }
    if (existing !== undefined) {
      actions.push({ kind: 'mcp-remove', agent, short, name: server.name });
    }
    actions.push({ kind: 'mcp-add', agent, short, name: server.name, config: server.config });
  }
  // The agent rewrites this file for these, so keep a copy of it first.
  const file = agentPath(target, spec.file);
  return actions.length > 0 ? [{ kind: 'backup', path: file, agent }, ...actions] : [];
}

async function planAgent(
  target: AgentSyncTarget,
  repoRoot: string,
  home: string,
  host: string,
): Promise<Action[]> {
  const read = await readAgentManifest(repoRoot, target.agent);
  if (!read.ok) {
    return read.missing ? [] : [{ kind: 'note', message: `${target.short}: ${read.error}` }];
  }
  if ((await statOrNull(target.dir)) === null) {
    const where = collapseHome(target.dir, home);
    return [
      {
        kind: 'note',
        message: `${target.short}: ${where} is not on this machine, so its config was skipped`,
      },
    ];
  }
  return [
    ...(await planItems(target, read.manifest, repoRoot)),
    ...(await planSettings(target, read.manifest, repoRoot, host)),
    ...(await planMcp(target, read.manifest, repoRoot)),
  ];
}

/** What would change to make each agent's folder match its part of the config repo. */
export async function planAgents(
  targets: readonly AgentSyncTarget[],
  repoRoot: string,
  home: string,
  host: string,
): Promise<Action[]> {
  const actions: Action[] = [];
  for (const target of targets) {
    actions.push(...(await planAgent(target, repoRoot, home, host)));
  }
  return actions;
}
