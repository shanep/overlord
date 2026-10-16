import path from 'node:path';

const WINDOWS_ROOT = /^[A-Za-z]:\\/u;

/** True when `child` is `parent` or sits somewhere below it. */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function isInsideAny(parents: readonly string[], child: string): boolean {
  return parents.some((parent) => isInside(parent, child));
}

/** Every directory from the filesystem root down to `dir`, root first. */
export function ancestorsRootFirst(dir: string): string[] {
  const out: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return out.toReversed();
    }
    current = parent;
  }
}

/** Expands a leading `~` or `~/` against `home`. Other paths pass through. */
export function expandHome(target: string, home: string): string {
  if (target === '~') {
    return home;
  }
  return target.startsWith('~/') ? path.join(home, target.slice(2)) : target;
}

/**
 * Joins under a directory that may be a Windows path (the managed policy dir
 * from ClaudePaths), so it keeps its own separators on a macOS or Linux host.
 */
export function joinUnder(dir: string, ...parts: string[]): string {
  return WINDOWS_ROOT.test(dir) ? path.win32.join(dir, ...parts) : path.join(dir, ...parts);
}

/** Path relative to `base` with forward slashes, for glob matching and details. */
export function relativePosix(base: string, target: string): string {
  return path.relative(base, target).split(path.sep).join('/');
}

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

/** Claude Code reads on and off env vars as 1, true, yes or on, in any case. */
export function envOn(value: string | undefined): boolean {
  return value !== undefined && TRUE_WORDS.has(value.trim().toLowerCase());
}

export function envOff(value: string | undefined): boolean {
  return value !== undefined && FALSE_WORDS.has(value.trim().toLowerCase());
}
