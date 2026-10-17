// Which Claude product ran a session, from the entrypoint its transcript
// records and its live registry entry both carry. The one rule for both, so
// a session's Fleet row and its Sessions row always agree.

import type { Surface } from '../../../shared/model.js';

/** Claude Code's entrypoint names, like cli, sdk-ts or claude-desktop, as a surface. */
export function surfaceForEntrypoint(entrypoint: string | null): Surface {
  if (entrypoint === null) {
    return 'cli';
  }
  if (entrypoint.startsWith('sdk')) {
    return 'sdk';
  }
  return entrypoint === 'claude-desktop' ? 'desktop-code' : 'cli';
}
