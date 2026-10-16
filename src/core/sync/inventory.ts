// Every config item on the machine, each with its sync badge. Read only.

import path from 'node:path';

import type { ConfigItem, ConfigScope } from '../../shared/model.js';
import type { ClaudePaths } from '../paths.js';

import type { Exec } from './exec.js';
import { readJsonOrUndefined, statOrNull } from './files.js';
import {
  builtInAgentItems,
  cloudSkillItems,
  contentSpecs,
  existingFileItems,
  fixedItem,
  hookItems,
  type ItemSpec,
  mcpItems,
  memorySpecs,
  pluginItems,
} from './inventory-sources.js';
import { LAYOUT, repoFile } from './layout.js';
import { readMcpFile, readProjectMcpServers, readUserMcpServers } from './mcp.js';
import { createStatusResolver, type PathStatus, type StatusResolver } from './repo-status.js';

export interface InventoryDeps {
  readonly paths: ClaudePaths;
  readonly exec: Exec;
  /** The local clone of the config repo, when one is connected. */
  readonly configRepoRoot: string | null;
  /** The open workspace folder, for project scope items. */
  readonly workspace: string | null;
}

const LOCAL_ONLY: PathStatus = { status: 'local-only', realPath: null, repo: null };
const VERSIONED: PathStatus = { status: 'versioned', realPath: null, repo: null };

async function settingsItems(
  resolver: StatusResolver,
  specs: readonly ItemSpec[],
): Promise<ConfigItem[]> {
  const items: ConfigItem[] = [];
  for (const spec of specs) {
    for (const file of await existingFileItems(resolver, [spec])) {
      items.push(file, ...hookItems(await readJsonOrUndefined(spec.path), file));
    }
  }
  return items;
}

async function repoMcpNames(configRepoRoot: string | null): Promise<ReadonlySet<string>> {
  if (configRepoRoot === null) {
    return new Set();
  }
  const servers = await readMcpFile(repoFile(configRepoRoot, LAYOUT.mcp));
  return new Set(servers.map((server) => server.name));
}

async function userItems(deps: InventoryDeps, resolver: StatusResolver): Promise<ConfigItem[]> {
  const { paths } = deps;
  const user: ConfigScope = 'user';
  const files = await existingFileItems(resolver, [
    { kind: 'claude-md', name: 'CLAUDE.md', scope: user, path: paths.userClaudeMd },
    {
      kind: 'keybindings',
      name: 'keybindings.json',
      scope: user,
      path: path.join(paths.configDir, 'keybindings.json'),
    },
  ]);
  const settings = await settingsItems(resolver, [
    { kind: 'settings', name: 'settings.json', scope: user, path: paths.userSettings },
  ]);
  const content = await contentSpecs(
    {
      rules: paths.userRulesDir,
      skills: paths.userSkillsDir,
      agents: paths.userAgentsDir,
      commands: paths.userCommandsDir,
      outputStyles: paths.userOutputStylesDir,
    },
    user,
  );
  const inRepo = await repoMcpNames(deps.configRepoRoot);
  const mcp = mcpItems(
    await readUserMcpServers(paths),
    { scope: user, path: paths.claudeJson },
    (server) => (inRepo.has(server.name) ? VERSIONED : LOCAL_ONLY),
  );
  return [
    ...files,
    ...settings,
    ...(await existingFileItems(resolver, content)),
    ...mcp,
    ...(await pluginItems(paths.pluginsDir, await readJsonOrUndefined(paths.userSettings))),
    ...(await existingFileItems(resolver, await memorySpecs(paths.projectsDir))),
    ...(await cloudSkillItems(paths.userSkillsDir)),
  ];
}

async function managedItems(paths: ClaudePaths): Promise<ConfigItem[]> {
  const managed: ConfigScope = 'managed';
  const specs: readonly ItemSpec[] = [
    {
      kind: 'claude-md',
      name: 'CLAUDE.md',
      scope: managed,
      path: path.join(paths.managedDir, 'CLAUDE.md'),
    },
    {
      kind: 'settings',
      name: 'managed-settings.json',
      scope: managed,
      path: path.join(paths.managedDir, 'managed-settings.json'),
    },
  ];
  const items: ConfigItem[] = [];
  for (const spec of specs) {
    if ((await statOrNull(spec.path)) !== null) {
      items.push(fixedItem(spec, 'managed'));
    }
  }
  const mcpFile = path.join(paths.managedDir, 'managed-mcp.json');
  const servers = await readMcpFile(mcpFile);
  const asManaged: PathStatus = { status: 'managed', realPath: null, repo: null };
  return [...items, ...mcpItems(servers, { scope: managed, path: mcpFile }, () => asManaged)];
}

async function projectItems(workspace: string, resolver: StatusResolver): Promise<ConfigItem[]> {
  const dotClaude = path.join(workspace, '.claude');
  const project: ConfigScope = 'project';
  const files = await existingFileItems(resolver, [
    {
      kind: 'claude-md',
      name: 'CLAUDE.md',
      scope: project,
      path: path.join(workspace, 'CLAUDE.md'),
    },
    {
      kind: 'claude-md',
      name: '.claude/CLAUDE.md',
      scope: project,
      path: path.join(dotClaude, 'CLAUDE.md'),
    },
    {
      kind: 'claude-md',
      name: 'CLAUDE.local.md',
      scope: 'local',
      path: path.join(workspace, 'CLAUDE.local.md'),
    },
  ]);
  const settings = await settingsItems(resolver, [
    {
      kind: 'settings',
      name: 'settings.json',
      scope: project,
      path: path.join(dotClaude, 'settings.json'),
    },
    {
      kind: 'settings',
      name: 'settings.local.json',
      scope: 'local',
      path: path.join(dotClaude, 'settings.local.json'),
    },
  ]);
  const content = await contentSpecs(
    {
      rules: path.join(dotClaude, 'rules'),
      skills: path.join(dotClaude, 'skills'),
      agents: path.join(dotClaude, 'agents'),
      commands: path.join(dotClaude, 'commands'),
      outputStyles: path.join(dotClaude, 'output-styles'),
    },
    project,
  );
  const mcpFile = path.join(workspace, '.mcp.json');
  const servers = await readProjectMcpServers(workspace);
  const mcpStatus = servers.length > 0 ? await resolver.resolve(mcpFile) : LOCAL_ONLY;
  const mcp = mcpItems(servers, { scope: project, path: mcpFile }, () => mcpStatus);
  return [...files, ...settings, ...(await existingFileItems(resolver, content)), ...mcp];
}

/** Scan user, managed, built-in and (when a workspace is open) project config. */
export async function scanInventory(deps: InventoryDeps): Promise<ConfigItem[]> {
  const resolver = await createStatusResolver(deps.exec, deps.configRepoRoot);
  const project = deps.workspace === null ? [] : await projectItems(deps.workspace, resolver);
  return [
    ...(await managedItems(deps.paths)),
    ...(await userItems(deps, resolver)),
    ...project,
    ...builtInAgentItems(),
  ];
}
