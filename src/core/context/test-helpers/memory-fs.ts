// An in-memory FileSystem for tests. Directories come from file paths plus
// any listed in `dirs`. Links map a path to a target, absolute or relative to
// the link's directory, and resolve in any path prefix like real symlinks.

import path from 'node:path';

import { byCodePoint, type FileKind, type FileSystem } from '../fs.js';

export interface MemoryTree {
  readonly files: Readonly<Record<string, string>>;
  readonly dirs?: readonly string[];
  readonly links?: Readonly<Record<string, string>>;
  /** Paths that exist but are neither files nor dirs, like a device. */
  readonly others?: readonly string[];
}

const MAX_HOPS = 40;

async function settle(): Promise<void> {
  await Promise.resolve();
}

/** Wraps a sync lookup so it behaves like the async node one. */
function later<T>(lookup: (target: string) => T): (target: string) => Promise<T> {
  return async (target) => {
    await settle();
    return lookup(target);
  };
}

function resolveLinks(target: string, links: Readonly<Record<string, string>>): string | null {
  let current = path.resolve(target);
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const parts = current.split('/').filter((part) => part !== '');
    let prefix = '/';
    let changed = false;
    for (const [index, part] of parts.entries()) {
      prefix = path.join(prefix, part);
      const link = links[prefix];
      if (link !== undefined) {
        const rest = parts.slice(index + 1);
        current = path.resolve(path.dirname(prefix), link, ...rest);
        changed = true;
        break;
      }
    }
    if (!changed) {
      return current;
    }
  }
  return null;
}

export function createMemoryFs(tree: MemoryTree): FileSystem {
  const links = tree.links ?? {};
  const files = new Map(
    Object.entries(tree.files).map(([file, text]) => [path.resolve(file), text]),
  );
  const others = new Set((tree.others ?? []).map((other) => path.resolve(other)));
  const dirs = new Set<string>(['/']);
  const entries = [...files.keys(), ...(tree.dirs ?? []), ...Object.keys(links), ...others];
  for (const entry of entries) {
    let dir = path.dirname(path.resolve(entry));
    while (!dirs.has(dir)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  for (const dir of tree.dirs ?? []) {
    dirs.add(path.resolve(dir));
  }
  const kindOf = (target: string): FileKind | null => {
    const real = resolveLinks(target, links);
    if (real === null) {
      return null;
    }
    if (files.has(real)) {
      return 'file';
    }
    if (dirs.has(real)) {
      return 'directory';
    }
    return others.has(real) ? 'other' : null;
  };
  const readText = (target: string): string | null => {
    const real = resolveLinks(target, links);
    return real === null ? null : (files.get(real) ?? null);
  };
  const listNames = (target: string): readonly string[] => {
    const real = resolveLinks(target, links);
    if (real === null || !dirs.has(real)) {
      return [];
    }
    const names = new Set<string>();
    for (const entry of [...files.keys(), ...dirs, ...Object.keys(links), ...others]) {
      if (entry !== real && path.dirname(entry) === real) {
        names.add(path.basename(entry));
      }
    }
    return [...names].toSorted(byCodePoint);
  };
  const realOf = (target: string): string | null =>
    kindOf(target) === null ? null : resolveLinks(target, links);
  return {
    kind: later(kindOf),
    readFile: later(readText),
    readdir: later(listNames),
    realpath: later(realOf),
  };
}
