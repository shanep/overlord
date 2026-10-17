// Overlord's own folder, ~/.overlord. It holds what belongs to Overlord rather
// than to any one agent: the hook socket, the install markers and worktrees.
// Kept free of other imports so the hook script can use it.

import path from 'node:path';

export function overlordHome(home: string): string {
  return path.join(home, '.overlord');
}
