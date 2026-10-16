// Builders for each kind of inventory item. inventory.ts wires them together
// for user, managed and project scope.

import path from 'node:path';

import type { ConfigItem, ConfigKind, ConfigScope, ConfigStatus } from '../../shared/model.js';

import { listDir, listFilesRecursive, readJsonOrUndefined, statOrNull } from './files.js';
import { compareStrings, isArray, isRecord } from './json.js';
import type { McpServer } from './mcp.js';
import { serverHasSecrets } from './mcp.js';
import type { PathStatus, StatusResolver } from './repo-status.js';

export interface ItemSpec {
  readonly kind: ConfigKind;
  readonly name: string;
  readonly scope: ConfigScope;
  readonly path: string;
}

export function itemId(scope: ConfigScope, kind: ConfigKind, name: string): string {
  return `${scope}:${kind}:${name}`;
}

/** An item whose path may be unknown, such as a built-in agent. */
export type ItemBase = Omit<ItemSpec, 'path'> & { readonly path: string | null };

export function fixedItem(spec: ItemBase, status: ConfigStatus): ConfigItem {
  return {
    id: itemId(spec.scope, spec.kind, spec.name),
    kind: spec.kind,
    name: spec.name,
    scope: spec.scope,
    path: spec.path,
    realPath: null,
    status,
    repo: null,
  };
}

function itemWithStatus(spec: ItemSpec, found: PathStatus): ConfigItem {
  return { ...fixedItem(spec, found.status), realPath: found.realPath, repo: found.repo };
}

async function fileItem(resolver: StatusResolver, spec: ItemSpec): Promise<ConfigItem> {
  return itemWithStatus(spec, await resolver.resolve(spec.path));
}

/** fileItem for each path that exists. */
export async function existingFileItems(
  resolver: StatusResolver,
  specs: readonly ItemSpec[],
): Promise<ConfigItem[]> {
  const items: ConfigItem[] = [];
  for (const spec of specs) {
    if ((await statOrNull(spec.path)) !== null) {
      items.push(await fileItem(resolver, spec));
    }
  }
  return items;
}

export const BUILT_IN_AGENTS: readonly string[] = [
  'Explore',
  'Plan',
  'general-purpose',
  'claude',
  'statusline-setup',
  'claude-code-guide',
];

export function builtInAgentItems(): ConfigItem[] {
  return BUILT_IN_AGENTS.map((name) =>
    fixedItem({ kind: 'agent', name, scope: 'built-in', path: null }, 'built-in'),
  );
}

export interface ContentDirs {
  readonly rules: string;
  readonly skills: string;
  readonly agents: string;
  readonly commands: string;
  readonly outputStyles: string;
}

interface Named {
  readonly name: string;
  readonly path: string;
}

/** Markdown files under `dir`, named by relative path without .md, with `/` as `separator`. */
export async function markdownFiles(dir: string, separator: string): Promise<readonly Named[]> {
  const files = await listFilesRecursive(dir);
  return files
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({
      name: file.slice(0, -3).split('/').join(separator),
      path: path.join(dir, ...file.split('/')),
    }));
}

/** Skill directories directly under `dir`. The synced folder holds claude.ai skills, listed separately. */
export async function skillDirs(dir: string): Promise<readonly Named[]> {
  const entries = await listDir(dir);
  return entries.filter((entry) => entry.isDirectory && entry.name !== 'synced');
}

export async function contentSpecs(dirs: ContentDirs, scope: ConfigScope): Promise<ItemSpec[]> {
  const groups: readonly (readonly [ConfigKind, readonly Named[]])[] = [
    ['rule', await markdownFiles(dirs.rules, '/')],
    ['skill', await skillDirs(dirs.skills)],
    ['agent', await markdownFiles(dirs.agents, '/')],
    ['command', await markdownFiles(dirs.commands, ':')],
    ['output-style', await markdownFiles(dirs.outputStyles, '/')],
  ];
  return groups.flatMap(([kind, found]) =>
    found.map((entry) => ({ kind, name: entry.name, scope, path: entry.path })),
  );
}

function hookNames(event: string, groups: unknown): string[] {
  const names: string[] = [];
  for (const group of isArray(groups) ? groups : []) {
    const value = isRecord(group) ? group['matcher'] : undefined;
    const matcher = typeof value === 'string' && value !== '' ? value : '*';
    const commands = isRecord(group) ? group['hooks'] : undefined;
    const count = isArray(commands) ? commands.length : 0;
    for (let at = 0; at < count; at += 1) {
      names.push(`${event}:${matcher}:${String(names.length)}`);
    }
  }
  return names;
}

/** Each hook command in a settings file, badged like the file it lives in. */
export function hookItems(settings: unknown, file: ConfigItem): ConfigItem[] {
  const hooks = isRecord(settings) ? settings['hooks'] : undefined;
  if (!isRecord(hooks)) {
    return [];
  }
  return Object.keys(hooks)
    .toSorted(compareStrings)
    .flatMap((event) => hookNames(event, hooks[event]))
    .map((name) => ({ ...file, id: itemId(file.scope, 'hook', name), kind: 'hook', name }));
}

export function mcpItems(
  servers: readonly McpServer[],
  base: Omit<ItemSpec, 'kind' | 'name'>,
  statusOf: (server: McpServer) => PathStatus,
): ConfigItem[] {
  return servers.map((server) => {
    const spec: ItemSpec = { ...base, kind: 'mcp-server', name: server.name };
    if (serverHasSecrets(server.config)) {
      return fixedItem(spec, 'secret');
    }
    return itemWithStatus(spec, statusOf(server));
  });
}

function installPathOf(entries: unknown): string | null {
  const first = isArray(entries) ? entries[0] : undefined;
  const value = isRecord(first) ? first['installPath'] : undefined;
  return typeof value === 'string' ? value : null;
}

async function pluginContent(id: string, root: string): Promise<ConfigItem[]> {
  const at = id.indexOf('@');
  const plugin = at === -1 ? id : id.slice(0, at);
  const specs = await contentSpecs(
    {
      rules: path.join(root, 'rules'),
      skills: path.join(root, 'skills'),
      agents: path.join(root, 'agents'),
      commands: path.join(root, 'commands'),
      outputStyles: path.join(root, 'output-styles'),
    },
    'plugin',
  );
  return specs.map((spec) => fixedItem({ ...spec, name: `${plugin}:${spec.name}` }, 'plugin'));
}

/** Plugins from enabledPlugins and installed_plugins.json, plus the skills, agents and commands they ship. */
export async function pluginItems(pluginsDir: string, settings: unknown): Promise<ConfigItem[]> {
  const installed = await readJsonOrUndefined(path.join(pluginsDir, 'installed_plugins.json'));
  const plugins = isRecord(installed) && isRecord(installed['plugins']) ? installed['plugins'] : {};
  const enabled = isRecord(settings) ? settings['enabledPlugins'] : undefined;
  const ids = new Set([...Object.keys(plugins), ...Object.keys(isRecord(enabled) ? enabled : {})]);
  const items: ConfigItem[] = [];
  for (const id of [...ids].toSorted(compareStrings)) {
    const root = installPathOf(plugins[id]);
    items.push(fixedItem({ kind: 'plugin', name: id, scope: 'plugin', path: root }, 'plugin'));
    if (root !== null) {
      items.push(...(await pluginContent(id, root)));
    }
  }
  return items;
}

/** Auto memory folders, one per project directory that has one. */
export async function memorySpecs(projectsDir: string): Promise<ItemSpec[]> {
  const specs: ItemSpec[] = [];
  for (const entry of await listDir(projectsDir)) {
    const memory = path.join(entry.path, 'memory');
    const info = await statOrNull(memory);
    if (info?.isDirectory() === true) {
      specs.push({ kind: 'memory', name: entry.name, scope: 'local', path: memory });
    }
  }
  return specs;
}

/** Skills pushed from claude.ai, under skills/synced/<bucket>/<name>. */
export async function cloudSkillItems(skillsDir: string): Promise<ConfigItem[]> {
  const items: ConfigItem[] = [];
  for (const bucket of await listDir(path.join(skillsDir, 'synced'))) {
    const skills = bucket.isDirectory ? await listDir(bucket.path) : [];
    for (const skill of skills.filter((entry) => entry.isDirectory)) {
      const spec: ItemSpec = { kind: 'skill', name: skill.name, scope: 'cloud', path: skill.path };
      items.push(fixedItem(spec, 'cloud-synced'));
    }
  }
  return items;
}
