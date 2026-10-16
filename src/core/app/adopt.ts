// Moves a local-only config item into the config repo layout and links it
// back, and records it in overlord.json. New agents and skills saved to user
// scope use the same linking once they are written into the repo.

import path from 'node:path';

import type { ConfigItem } from '../../shared/model.js';
import type { ClaudePaths } from '../paths.js';
import type { Action } from '../sync/actions.js';
import { hashPath } from '../sync/files.js';
import { collapseHome, LAYOUT, repoFile } from '../sync/layout.js';
import type { ManifestItem } from '../sync/manifest.js';
import {
  emptyManifest,
  isSafeHomeTarget,
  isSafeRepoPath,
  readManifest,
  serializeManifest,
  upsertItems,
} from '../sync/manifest.js';
import { planLink, prepareTarget } from '../sync/plan.js';

interface KindPlace {
  readonly kind: ConfigItem['kind'];
  readonly dir: (paths: ClaudePaths) => string;
  readonly repo: string;
}

// Items that live as files or folders under a known ~/.claude folder.
const FOLDERS: readonly KindPlace[] = [
  { kind: 'skill', dir: (paths) => paths.userSkillsDir, repo: LAYOUT.skills },
  { kind: 'agent', dir: (paths) => paths.userAgentsDir, repo: LAYOUT.agents },
  { kind: 'command', dir: (paths) => paths.userCommandsDir, repo: LAYOUT.commands },
  { kind: 'rule', dir: (paths) => paths.userRulesDir, repo: LAYOUT.globalRules },
  { kind: 'output-style', dir: (paths) => paths.userOutputStylesDir, repo: LAYOUT.outputStyles },
];

function relativeUnder(dir: string, target: string): string | null {
  const relative = path.relative(dir, target).split(path.sep).join('/');
  return isSafeRepoPath(relative) ? relative : null;
}

function fileItem(
  item: Pick<ConfigItem, 'kind'>,
  paths: ClaudePaths,
  target: string,
): ManifestItem | null {
  const home = collapseHome(target, paths.home);
  if (item.kind === 'claude-md' && target === paths.userClaudeMd) {
    return {
      id: 'claude-md',
      kind: 'claude-md',
      source: LAYOUT.globalClaudeMd,
      target: home,
      mode: 'link',
    };
  }
  if (item.kind === 'keybindings' && target === path.join(paths.configDir, 'keybindings.json')) {
    return {
      id: 'keybindings',
      kind: 'keybindings',
      source: 'global/keybindings.json',
      target: home,
      mode: 'link',
    };
  }
  return null;
}

/** The manifest entry an adopted item gets, or null when Overlord cannot link that item. */
export function manifestItemFor(
  item: Pick<ConfigItem, 'kind' | 'scope' | 'path'>,
  paths: ClaudePaths,
): ManifestItem | null {
  if (item.scope !== 'user' || item.path === null) {
    return null;
  }
  const target = item.path;
  if (!isSafeHomeTarget(collapseHome(target, paths.home))) {
    return null;
  }
  const place = FOLDERS.find((candidate) => candidate.kind === item.kind);
  if (place === undefined) {
    return fileItem(item, paths, target);
  }
  const relative = relativeUnder(place.dir(paths), target);
  if (relative === null) {
    return null;
  }
  return {
    id: `${item.kind}:${relative.replace(/\.md$/u, '')}`,
    kind: item.kind,
    source: `${place.repo}/${relative}`,
    target: collapseHome(target, paths.home),
    mode: 'link',
  };
}

/** Link ~/.claude at the repo copy and record the item in overlord.json. */
export async function planLinkBack(
  repoRoot: string,
  item: ManifestItem,
  target: string,
): Promise<Action[]> {
  const read = await readManifest(repoRoot);
  const manifest = upsertItems(read.ok ? read.manifest : emptyManifest(), [item]);
  const manifestFile = repoFile(repoRoot, LAYOUT.manifest);
  return [
    ...(await planLink(repoFile(repoRoot, item.source), target)),
    ...(await prepareTarget(manifestFile)),
    { kind: 'write-file', target: manifestFile, content: serializeManifest(manifest) },
  ];
}

export type AdoptPlan =
  | { readonly ok: true; readonly actions: readonly Action[] }
  | { readonly ok: false; readonly reason: string };

/** Copy into the repo, then link back. Refuses when the repo already has different content there. */
export async function planAdopt(
  repoRoot: string,
  item: ManifestItem,
  target: string,
): Promise<AdoptPlan> {
  const destination = repoFile(repoRoot, item.source);
  const there = await hashPath(destination);
  if (there !== null && there !== (await hashPath(target))) {
    return {
      ok: false,
      reason: `${item.source} already exists in the config repo with different content.`,
    };
  }
  const copy: Action[] =
    there === null
      ? [
          ...(await prepareTarget(destination)),
          { kind: 'copy', source: target, target: destination },
        ]
      : [];
  return { ok: true, actions: [...copy, ...(await planLinkBack(repoRoot, item, target))] };
}
