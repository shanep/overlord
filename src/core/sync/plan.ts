// Turns the manifest into a list of actions by comparing it with the disk.
// Anything already in place produces no action, which is what makes apply
// idempotent: plan, apply, plan again gives an empty list.

import { readlink } from 'node:fs/promises';
import path from 'node:path';

import type { ClaudePaths } from '../paths.js';

import type { Action } from './actions.js';
import { hashPath, lstatOrNull, pathExists, readJsonOrUndefined, statOrNull } from './files.js';
import { isArray, isRecord, jsonEqual } from './json.js';
import { expandHome, remoteSlug, repoFile } from './layout.js';
import type { ExternalItem, Manifest, ManifestItem } from './manifest.js';
import { readMcpFile, readUserMcpServers } from './mcp.js';
import { placeholdersInText } from './secrets.js';
import { generateSettingsFromRepo } from './settings-gen.js';

/** True when `target` is a symlink that points at `source`. */
export async function linksTo(target: string, source: string): Promise<boolean> {
  const info = await lstatOrNull(target);
  if (info?.isSymbolicLink() !== true) {
    return false;
  }
  const pointed = path.resolve(path.dirname(target), await readlink(target));
  return pointed === path.resolve(source);
}

/** mkdir for a missing parent and a backup when something is already there. */
export async function prepareTarget(target: string): Promise<Action[]> {
  const actions: Action[] = [];
  const parent = path.dirname(target);
  if ((await statOrNull(parent)) === null) {
    actions.push({ kind: 'mkdir', path: parent });
  }
  if (await pathExists(target)) {
    actions.push({ kind: 'backup', path: target });
  }
  return actions;
}

export async function planLink(source: string, target: string): Promise<Action[]> {
  if (await linksTo(target, source)) {
    return [];
  }
  return [...(await prepareTarget(target)), { kind: 'link', source, target }];
}

export async function planCopy(source: string, target: string): Promise<Action[]> {
  const info = await lstatOrNull(target);
  const isLink = info?.isSymbolicLink() === true;
  if (info !== null && !isLink && (await hashPath(target)) === (await hashPath(source))) {
    return [];
  }
  return [...(await prepareTarget(target)), { kind: 'copy', source, target }];
}

async function planSettings(
  item: ManifestItem,
  repoRoot: string,
  target: string,
  host: string,
): Promise<Action[]> {
  const generated = await generateSettingsFromRepo(repoRoot, host, item.source);
  const info = await lstatOrNull(target);
  const isFile = info?.isFile() === true;
  if (isFile && jsonEqual(await readJsonOrUndefined(target), generated.settings)) {
    return [];
  }
  return [
    ...(await prepareTarget(target)),
    { kind: 'generate-settings', target, content: generated.content },
  ];
}

async function planItem(
  item: ManifestItem,
  repoRoot: string,
  paths: ClaudePaths,
  host: string,
): Promise<Action[]> {
  const source = repoFile(repoRoot, item.source);
  const target = expandHome(item.target, paths.home);
  if (!(await pathExists(source))) {
    return [
      { kind: 'note', message: `${item.id}: ${item.source} is missing from the config repo` },
    ];
  }
  if (item.mode === 'link') {
    return planLink(source, target);
  }
  if (item.mode === 'copy') {
    return planCopy(source, target);
  }
  if (item.kind !== 'settings') {
    return [{ kind: 'note', message: `${item.id}: generate mode only works for settings` }];
  }
  return planSettings(item, repoRoot, target, host);
}

/** The folder name a repo URL clones into by default. */
export function repoName(url: string): string {
  const slug = remoteSlug(url);
  const last = (slug ?? url).split(/[/\\]/u).findLast((part) => part !== '') ?? 'repo';
  return last.endsWith('.git') ? last.slice(0, -4) : last;
}

export function checkoutOf(external: ExternalItem, home: string): string {
  return expandHome(external.checkout ?? `~/repos/${repoName(external.repoUrl)}`, home);
}

async function planExternals(
  manifest: Manifest,
  home: string,
): Promise<{ clones: Action[]; links: Action[] }> {
  const clones: Action[] = [];
  const links: Action[] = [];
  const cloning = new Set<string>();
  for (const external of manifest.external) {
    const destination = checkoutOf(external, home);
    if (!cloning.has(destination) && !(await pathExists(destination))) {
      cloning.add(destination);
      clones.push({ kind: 'clone-external', repoUrl: external.repoUrl, destination });
    }
    const source = path.join(destination, ...external.path.split('/'));
    links.push(...(await planLink(source, expandHome(external.target, home))));
  }
  return { clones, links };
}

function claude(args: readonly string[], description: string): Action {
  return { kind: 'run-command', command: 'claude', args, description };
}

async function planPlugins(manifest: Manifest, paths: ClaudePaths): Promise<Action[]> {
  const known = await readJsonOrUndefined(path.join(paths.pluginsDir, 'known_marketplaces.json'));
  const installedFile = await readJsonOrUndefined(
    path.join(paths.pluginsDir, 'installed_plugins.json'),
  );
  const installed = isRecord(installedFile) ? installedFile['plugins'] : undefined;
  const actions: Action[] = [];
  for (const market of manifest.plugins.marketplaces) {
    if (!isRecord(known) || !Object.hasOwn(known, market.name)) {
      actions.push(
        claude(['plugin', 'marketplace', 'add', market.source], `add marketplace ${market.name}`),
      );
    }
  }
  for (const id of manifest.plugins.enabled) {
    if (!isRecord(installed) || !Object.hasOwn(installed, id)) {
      actions.push(claude(['plugin', 'install', id, '--scope', 'user'], `install plugin ${id}`));
    }
  }
  return actions;
}

/**
 * Whether the live server config already matches the repo's. Keys the CLI
 * adds on its own are ignored, and a string holding a placeholder matches any
 * string, since the secret itself is never read back for comparison.
 */
export function matchesTemplate(template: unknown, actual: unknown): boolean {
  if (typeof template === 'string') {
    return placeholdersInText(template).length > 0
      ? typeof actual === 'string'
      : template === actual;
  }
  if (isArray(template)) {
    return (
      isArray(actual) &&
      actual.length === template.length &&
      template.every((entry, index) => matchesTemplate(entry, actual[index]))
    );
  }
  if (isRecord(template)) {
    return (
      isRecord(actual) &&
      Object.entries(template).every(([key, value]) => matchesTemplate(value, actual[key]))
    );
  }
  return jsonEqual(template, actual);
}

async function planMcp(
  manifest: Manifest,
  repoRoot: string,
  paths: ClaudePaths,
): Promise<Action[]> {
  if (manifest.mcp === null) {
    return [];
  }
  const wanted = await readMcpFile(repoFile(repoRoot, manifest.mcp));
  const live = await readUserMcpServers(paths);
  const current = new Map(live.map((server) => [server.name, server.config]));
  const actions: Action[] = [];
  for (const server of wanted) {
    const existing = current.get(server.name);
    if (existing !== undefined && matchesTemplate(server.config, existing)) {
      continue;
    }
    if (existing !== undefined) {
      actions.push(
        claude(
          ['mcp', 'remove', '--scope', 'user', server.name],
          `replace MCP server ${server.name}`,
        ),
      );
    }
    const json = JSON.stringify(server.config);
    actions.push(
      claude(
        ['mcp', 'add-json', '--scope', 'user', server.name, json],
        `add MCP server ${server.name}`,
      ),
    );
  }
  // claude rewrites ~/.claude.json for these, so keep a copy of it first.
  return actions.length > 0 ? [{ kind: 'backup', path: paths.claudeJson }, ...actions] : [];
}

function dedupeMkdirs(actions: readonly Action[]): Action[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (action.kind !== 'mkdir') {
      return true;
    }
    const fresh = !seen.has(action.path);
    seen.add(action.path);
    return fresh;
  });
}

/** Everything that would change to make this machine match the manifest. */
export async function planApply(
  manifest: Manifest,
  repoRoot: string,
  paths: ClaudePaths,
  host: string,
): Promise<Action[]> {
  const externals = await planExternals(manifest, paths.home);
  const items: Action[] = [];
  for (const item of manifest.items) {
    items.push(...(await planItem(item, repoRoot, paths, host)));
  }
  return dedupeMkdirs([
    ...externals.clones,
    ...items,
    ...externals.links,
    ...(await planPlugins(manifest, paths)),
    ...(await planMcp(manifest, repoRoot, paths)),
  ]);
}
