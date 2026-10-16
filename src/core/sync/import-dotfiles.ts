// One time move of a dot-files style claude/ folder (CLAUDE.md,
// settings.json, skills/...) into the config repo layout. The plan copies each
// file into the repo, backs up and removes the original, repoints ~/.claude at
// the repo, records the items in overlord.json, and leaves a pointer README
// behind. Nothing runs until the caller passes the actions to applyPlan.

import path from 'node:path';

import type { ClaudePaths } from '../paths.js';

import type { Action } from './actions.js';
import { hashPath, isInside, listDir, readJsonOrUndefined, realpathOrSelf } from './files.js';
import { stableJson } from './json.js';
import { collapseHome, expandHome, LAYOUT, machineSettingsPath, repoFile } from './layout.js';
import {
  emptyManifest,
  isSafeHomeTarget,
  type Manifest,
  type ManifestItem,
  readManifest,
  serializeManifest,
  upsertItems,
} from './manifest.js';
import { planLink, prepareTarget } from './plan.js';
import { generateSettings } from './settings-gen.js';

export interface ImportPlan {
  readonly actions: readonly Action[];
  /** The manifest the plan writes to overlord.json. */
  readonly manifest: Manifest;
  readonly moved: readonly { readonly from: string; readonly to: string }[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

interface Mapping {
  /** Path inside the dot-files folder. */
  readonly from: string;
  readonly item: ManifestItem;
}

const FOLDERS: readonly {
  readonly dir: string;
  readonly kind: ManifestItem['kind'];
  readonly repo: string;
}[] = [
  { dir: 'skills', kind: 'skill', repo: LAYOUT.skills },
  { dir: 'agents', kind: 'agent', repo: LAYOUT.agents },
  { dir: 'commands', kind: 'command', repo: LAYOUT.commands },
  { dir: 'rules', kind: 'rule', repo: LAYOUT.globalRules },
  { dir: 'output-styles', kind: 'output-style', repo: LAYOUT.outputStyles },
];

function topLevel(name: string, claudeHome: string): ManifestItem | null {
  if (name === 'CLAUDE.md') {
    return {
      id: 'claude-md',
      kind: 'claude-md',
      source: LAYOUT.globalClaudeMd,
      target: `${claudeHome}/CLAUDE.md`,
      mode: 'link',
    };
  }
  if (name === 'settings.json') {
    return {
      id: 'settings',
      kind: 'settings',
      source: LAYOUT.globalSettings,
      target: `${claudeHome}/settings.json`,
      mode: 'generate',
    };
  }
  if (name === 'keybindings.json') {
    return {
      id: 'keybindings',
      kind: 'keybindings',
      source: 'global/keybindings.json',
      target: `${claudeHome}/keybindings.json`,
      mode: 'link',
    };
  }
  return null;
}

async function mappingsFor(
  dotfiles: string,
  claudeHome: string,
): Promise<{ mappings: Mapping[]; skipped: { path: string; reason: string }[] }> {
  const mappings: Mapping[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const entry of await listDir(dotfiles)) {
    const folder = FOLDERS.find((candidate) => candidate.dir === entry.name);
    const item = topLevel(entry.name, claudeHome);
    if (item !== null) {
      mappings.push({ from: entry.path, item });
    } else if (folder !== undefined && entry.isDirectory) {
      for (const child of await listDir(entry.path)) {
        const id = `${folder.kind}:${child.isDirectory ? child.name : child.name.replace(/\.md$/u, '')}`;
        const source = `${folder.repo}/${child.name}`;
        const target = `${claudeHome}/${folder.dir}/${child.name}`;
        mappings.push({
          from: child.path,
          item: { id, kind: folder.kind, source, target, mode: 'link' },
        });
      }
    } else if (entry.name !== 'README.md') {
      skipped.push({
        path: entry.path,
        reason: 'not a Claude config file Overlord knows how to move',
      });
    }
  }
  return { mappings, skipped };
}

export function pointerReadme(repoLocation: string): string {
  return [
    '# claude',
    '',
    `This folder moved to the claude-config repo (${repoLocation}).`,
    'Overlord links ~/.claude to that repo now, so edit the files there.',
    '',
  ].join('\n');
}

async function placeTarget(
  mapping: Mapping,
  repoRoot: string,
  paths: ClaudePaths,
  host: string,
): Promise<Action[]> {
  const target = expandHome(mapping.item.target, paths.home);
  if (mapping.item.mode === 'link') {
    return planLink(repoFile(repoRoot, mapping.item.source), target);
  }
  const machine = await readJsonOrUndefined(repoFile(repoRoot, machineSettingsPath(host)));
  const content = stableJson(generateSettings(await readJsonOrUndefined(mapping.from), machine));
  return [...(await prepareTarget(target)), { kind: 'generate-settings', target, content }];
}

/** Links elsewhere in ~/.claude that still point into the dot-files folder after the move. */
async function strayLinks(
  dotfiles: string,
  paths: ClaudePaths,
  planned: ReadonlySet<string>,
): Promise<Action[]> {
  const real = await realpathOrSelf(dotfiles);
  const entries = [...(await listDir(paths.configDir)), ...(await listDir(paths.userSkillsDir))];
  const notes: Action[] = [];
  for (const entry of entries) {
    const resolved = await realpathOrSelf(entry.path);
    if (entry.isSymlink && isInside(resolved, real) && !planned.has(entry.path)) {
      notes.push({
        kind: 'note',
        message: `${collapseHome(entry.path, paths.home)} still points into ${collapseHome(dotfiles, paths.home)}`,
      });
    }
  }
  return notes;
}

/**
 * Plan the move of `dotfilesClaudeDir` into `configRepoRoot`. Files that
 * already exist in the repo with different content are skipped, never merged.
 */
export async function planImportFromDotfiles(
  dotfilesClaudeDir: string,
  configRepoRoot: string,
  paths: ClaudePaths,
  host: string,
): Promise<ImportPlan> {
  const claudeHome = collapseHome(paths.configDir, paths.home);
  const base = await readManifest(configRepoRoot);
  const existing = base.ok ? base.manifest : emptyManifest();
  if (!isSafeHomeTarget(`${claudeHome}/CLAUDE.md`)) {
    const message = `${paths.configDir} is outside the home folder, so it cannot be described in overlord.json`;
    return { actions: [{ kind: 'note', message }], manifest: existing, moved: [], skipped: [] };
  }
  const { mappings, skipped } = await mappingsFor(dotfilesClaudeDir, claudeHome);
  const moves: Action[] = [];
  const places: Action[] = [];
  const moved: { from: string; to: string }[] = [];
  const items: ManifestItem[] = [];
  for (const mapping of mappings) {
    const to = repoFile(configRepoRoot, mapping.item.source);
    const there = await hashPath(to);
    if (there !== null && there !== (await hashPath(mapping.from))) {
      skipped.push({
        path: mapping.from,
        reason: `${mapping.item.source} already exists in the repo with different content`,
      });
      continue;
    }
    if (there === null) {
      moves.push(...(await prepareTarget(to)), { kind: 'copy', source: mapping.from, target: to });
    }
    moves.push({ kind: 'backup', path: mapping.from }, { kind: 'remove', path: mapping.from });
    places.push(...(await placeTarget(mapping, configRepoRoot, paths, host)));
    moved.push({ from: mapping.from, to });
    items.push(mapping.item);
  }
  const manifest = upsertItems(existing, items);
  const manifestFile = repoFile(configRepoRoot, LAYOUT.manifest);
  const readme = path.join(dotfilesClaudeDir, 'README.md');
  const planned = new Set(items.map((item) => expandHome(item.target, paths.home)));
  const actions: Action[] = [
    ...moves,
    ...places,
    ...(await prepareTarget(manifestFile)),
    { kind: 'write-file', target: manifestFile, content: serializeManifest(manifest) },
    ...(await prepareTarget(readme)),
    {
      kind: 'write-file',
      target: readme,
      content: pointerReadme(collapseHome(configRepoRoot, paths.home)),
    },
    ...(await strayLinks(dotfilesClaudeDir, paths, planned)),
  ];
  return { actions, manifest, moved, skipped };
}
