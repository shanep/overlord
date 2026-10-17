// The config items of each agent past Claude Code, badged like Claude's:
// instruction files, skills, agent files, the settings file and the user MCP
// servers. Anything the denylist names (sign in files, sessions, logs,
// databases, caches) is never listed, so it can never be adopted either.

import type { ConfigItem, ConfigKind, ConfigStatus } from '../../shared/model.js';

import { readAgentManifest, type AgentManifest } from './agent-manifest.js';
import { agentPath, type AgentSyncTarget } from './agent-plan.js';
import { changedEntries, readSettings, entriesToSync } from './agent-settings.js';
import { isDeniedAgentPath } from './denylist.js';
import { listDir, readJsonOrUndefined, statOrNull } from './files.js';
import { agentMachineSettingsPath, repoFile } from './layout.js';
import { readMcpFile, serverHasSecrets } from './mcp.js';
import type { PathStatus, StatusResolver } from './repo-status.js';
import { generateSettings } from './settings-gen.js';

/** Something in an agent's folder that can sync. */
export interface AgentEntry {
  readonly kind: ConfigKind;
  /** The file or folder name, like "AGENTS.md" or a skill's folder. */
  readonly name: string;
  /** Inside the agent's folder, with forward slashes. */
  readonly relative: string;
  readonly path: string;
}

/** The instruction files, skills and agent files on disk, minus anything denied. */
export async function agentEntries(target: AgentSyncTarget): Promise<AgentEntry[]> {
  const found: AgentEntry[] = [];
  for (const file of target.sync.files) {
    const at = agentPath(target, file.file);
    const info = await statOrNull(at);
    if (info?.isFile() === true) {
      const name = file.file.split('/').at(-1) ?? file.file;
      found.push({ kind: file.kind, name, relative: file.file, path: at });
    }
  }
  for (const folder of target.sync.folders) {
    const { entries } = folder;
    for (const entry of await listDir(agentPath(target, folder.dir))) {
      // Dot folders, like Codex's skills/.system, hold what the agent ships.
      const wanted =
        entries === 'dirs'
          ? entry.isDirectory
          : !entry.isDirectory && entry.name.endsWith(entries.suffix);
      if (wanted && !entry.name.startsWith('.')) {
        const relative = `${folder.dir}/${entry.name}`;
        found.push({ kind: folder.kind, name: entry.name, relative, path: entry.path });
      }
    }
  }
  return found.filter((entry) => !isDeniedAgentPath(entry.path, target.dir));
}

/** The id and display name for an agent's item, kept apart from Claude Code's. */
export function agentItemBase(
  target: AgentSyncTarget,
  kind: ConfigKind,
  name: string,
): Pick<ConfigItem, 'id' | 'agent' | 'kind' | 'name' | 'scope'> {
  return {
    id: `${target.agent}:user:${kind}:${name}`,
    agent: target.agent,
    kind,
    name: `${name} (${target.short})`,
    scope: 'user',
  };
}

function item(
  target: AgentSyncTarget,
  entry: Pick<AgentEntry, 'kind' | 'name' | 'path'>,
  found: PathStatus,
): ConfigItem {
  return {
    ...agentItemBase(target, entry.kind, entry.name),
    path: entry.path,
    realPath: found.realPath,
    status: found.status,
    repo: found.repo,
  };
}

/** The agent's part of the connected config repo, or null when there is none. */
interface RepoView {
  readonly root: string;
  readonly manifest: AgentManifest;
  readonly host: string;
}

async function settingsStatus(
  target: AgentSyncTarget,
  repo: RepoView | null,
  live: unknown,
): Promise<ConfigStatus> {
  const spec = target.sync.settings;
  const shared = repo?.manifest.settings ?? null;
  if (spec === null || repo === null || shared === null) {
    return 'local-only';
  }
  const machine = agentMachineSettingsPath(target.agent, repo.host);
  const generated = generateSettings(
    await readJsonOrUndefined(repoFile(repo.root, shared)),
    await readJsonOrUndefined(repoFile(repo.root, machine)),
  );
  const missing = changedEntries(entriesToSync(generated, spec), live);
  const extra = changedEntries(entriesToSync(live, spec), generated);
  return missing.length === 0 && extra.length === 0 ? 'versioned' : 'modified';
}

const UNLINKED = { realPath: null, repo: null } as const;

async function settingsItems(
  target: AgentSyncTarget,
  repo: RepoView | null,
): Promise<ConfigItem[]> {
  const spec = target.sync.settings;
  if (spec === null) {
    return [];
  }
  const file = agentPath(target, spec.file);
  const live = await readSettings(file, spec.format);
  const info = await statOrNull(file);
  if (info === null || !live.ok) {
    return [];
  }
  const status = await settingsStatus(target, repo, live.value);
  return [item(target, { kind: 'settings', name: spec.file, path: file }, { ...UNLINKED, status })];
}

async function repoServerNames(repo: RepoView | null): Promise<ReadonlySet<string>> {
  const relative = repo?.manifest.mcp ?? null;
  if (repo === null || relative === null) {
    return new Set();
  }
  const servers = await readMcpFile(repoFile(repo.root, relative));
  return new Set(servers.map((server) => server.name));
}

function mcpStatus(versioned: boolean, config: Readonly<Record<string, unknown>>): ConfigStatus {
  if (!versioned) {
    return 'local-only';
  }
  return serverHasSecrets(config) ? 'secret' : 'versioned';
}

async function mcpItems(target: AgentSyncTarget, repo: RepoView | null): Promise<ConfigItem[]> {
  const spec = target.sync.mcp;
  if (spec === null) {
    return [];
  }
  const inRepo = await repoServerNames(repo);
  const file = agentPath(target, spec.file);
  const servers = (await spec.read(target.dir)) ?? [];
  return servers.map((server) => {
    const status = mcpStatus(inRepo.has(server.name), server.config);
    return item(
      target,
      { kind: 'mcp-server', name: server.name, path: file },
      { ...UNLINKED, status },
    );
  });
}

/** Every item of one agent that can sync. Nothing when its folder is not on this machine. */
export async function agentInventory(
  target: AgentSyncTarget,
  resolver: StatusResolver,
  host: string,
): Promise<ConfigItem[]> {
  if ((await statOrNull(target.dir)) === null) {
    return [];
  }
  const root = resolver.configRoot;
  const read = root === null ? null : await readAgentManifest(root, target.agent);
  const repo = root !== null && read?.ok === true ? { root, manifest: read.manifest, host } : null;
  const files: ConfigItem[] = [];
  for (const entry of await agentEntries(target)) {
    files.push(item(target, entry, await resolver.resolve(entry.path)));
  }
  return [...files, ...(await settingsItems(target, repo)), ...(await mcpItems(target, repo))];
}
