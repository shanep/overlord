import path from 'node:path';

/** A row title: the given one, else the last part of cwd, else the fallback. */
export function pickTitle(title: string | null, cwd: string | null, fallback: string): string {
  const trimmed = title?.trim() ?? '';
  if (trimmed !== '') {
    return trimmed;
  }
  const base = cwd === null ? '' : path.basename(cwd);
  return base === '' ? fallback : base;
}
