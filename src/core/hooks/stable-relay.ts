// A copy of the hook relay at a path that stays the same in every version of
// Overlord. The extension's own folder has its version in its name, so a hook
// command that points into it changes with each update. Codex CLI ties hook
// trust to a hash of the hook's definition, command included, so a command
// that changes makes the user trust Overlord's hooks again after every update.
// The copy is refreshed on each install and each start, and the command that
// names it never changes.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readOptional, writeFileAtomic } from '../knobs/atomic-file.js';
import { overlordHome } from '../overlord-home.js';

/** ~/.overlord/bin/overlord-hook.cjs. */
export function stableRelayPath(home: string): string {
  return path.join(overlordHome(home), 'bin', 'overlord-hook.cjs');
}

/** The command that runs the copy. It contains "overlord-hook", which marks Overlord's hooks. */
export function stableHookCommand(home: string): string {
  return `node "${stableRelayPath(home)}"`;
}

/**
 * Copies the extension's relay to the stable path when the copy is missing
 * or differs, and returns the command that runs it.
 */
export async function installStableRelay(extensionPath: string, home: string): Promise<string> {
  const target = stableRelayPath(home);
  const content = await readFile(path.join(extensionPath, 'dist', 'overlord-hook.cjs'), 'utf8');
  if ((await readOptional(target)) !== content) {
    await writeFileAtomic({ target, content, backup: null });
  }
  return stableHookCommand(home);
}
