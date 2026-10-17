// Actions for the premade skills and agents in the Skills and Agents views:
// show a source, search skills.sh, open an entry's page, and install one.
// Installing asks where it goes the same way New skill and New agent do,
// copies the files from GitHub, links a config repo copy into ~/.claude and
// opens the file so it can be read before a session uses it.

import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CatalogKind } from '../../shared/catalog.js';
import { nameProblems } from '../authoring/schema.js';
import { installFiles, relativeInside } from '../catalog/files.js';
import type { FoundEntry } from '../catalog/list.js';
import { fallbackName, readFrontmatter } from '../catalog/list.js';

import type { ActionHandlers } from './action-types.js';
import type { Destination } from './actions-authoring.js';
import { destinationFile, linkIntoClaude, pickDestination } from './actions-authoring.js';
import { pickAuthoringTarget } from './authoring.js';
import { messageOf } from './errors.js';
import type { Runtime } from './runtime.js';

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** The name the entry gives itself when Claude Code accepts it, else its folder or file name. */
function installName(kind: CatalogKind, text: string, entryPath: string): string {
  const named = readFrontmatter(text).name;
  if (named !== null && nameProblems(kind, named).length === 0) {
    return named;
  }
  const fallback = fallbackName(entryPath);
  const [problem] = nameProblems(kind, fallback);
  if (problem !== undefined) {
    throw new Error(`"${fallback}" cannot be installed under that name: ${problem}`);
  }
  return fallback;
}

/** A skill can go in any agent's folder. The premade agents are Claude Code's, so they go in its scopes. */
async function installDestination(rt: Runtime, kind: CatalogKind): Promise<Destination | null> {
  const target = kind === 'skill' ? await pickAuthoringTarget(rt, kind) : null;
  return pickDestination(rt, target === null ? null : { kind, target });
}

/** Installs the entry. Null when the user backed out, else what to tell them. */
export async function installEntry(
  rt: Runtime,
  kind: CatalogKind,
  found: FoundEntry,
): Promise<string | null> {
  const { reader } = rt.catalogs;
  const { repo } = found.entry;
  const plan = await installFiles(reader, kind, found);
  const entryText = await reader.text(repo, plan.entryPath);
  const name = installName(kind, entryText, plan.entryPath);
  const destination = await installDestination(rt, kind);
  if (destination === null) {
    return null;
  }
  const entryFile = destinationFile(kind, destination, name);
  const root = kind === 'agent' ? entryFile : path.dirname(entryFile);
  if (await exists(root)) {
    if (!(await rt.host.confirm(`${root} already exists. Replace it?`, 'Replace'))) {
      return null;
    }
    if (kind === 'skill') {
      await rm(root, { recursive: true, force: true });
    }
  }
  const folder = path.posix.dirname(plan.entryPath);
  for (const file of plan.files) {
    const relative = kind === 'agent' ? null : relativeInside(folder, file.path);
    const target = relative === null ? entryFile : path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      file.path === plan.entryPath ? entryText : await reader.bytes(repo, file.path),
    );
  }
  if (destination.repoRoot !== null) {
    await linkIntoClaude(rt, kind, name, destination.repoRoot);
  }
  await rt.host.openFile(entryFile);
  await Promise.all([rt.caches.config.refresh(), rt.caches.library.refresh()]);
  return `Installed ${name} from ${repo} into ${root}. New sessions can use it. Read it over in the editor.`;
}

export const catalogActions: ActionHandlers<
  'browseCatalog' | 'searchCatalog' | 'openCatalogLink' | 'installCatalog'
> = {
  browseCatalog: async ({ rt }, action) => {
    await rt.catalogs[action.kind].browse(action.source);
  },
  searchCatalog: async ({ rt }, action) => {
    await rt.catalogs[action.kind].search(action.query);
  },
  openCatalogLink: async ({ rt }, action) => {
    // Only a page the catalog listed, so the webview cannot open any URL it likes.
    if (rt.catalogs[action.kind].knowsLink(action.url) && action.url.startsWith('https://')) {
      await rt.host.openExternal(action.url);
    }
  },
  installCatalog: async ({ rt }, action) => {
    const browser = rt.catalogs[action.kind];
    const found = browser.entry(action.entryId);
    if (browser.view().installing !== null) {
      return;
    }
    if (found === undefined) {
      browser.installing(null, {
        ok: false,
        text: 'That one is not in the list any more. Pick it again.',
      });
      return;
    }
    browser.installing(action.entryId, null);
    try {
      const text = await installEntry(rt, action.kind, found);
      browser.installing(null, text === null ? null : { ok: true, text });
    } catch (error) {
      browser.installing(null, { ok: false, text: messageOf(error) });
    }
  },
};
