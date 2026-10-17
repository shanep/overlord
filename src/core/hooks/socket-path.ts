// Where the hook server listens. Kept apart from server.ts so the hook script
// can import it without pulling zod and the rest of the server into its bundle.
// One socket serves every agent, so it lives in ~/.overlord, not in any one
// agent's config folder.

import { createHash } from 'node:crypto';
import path from 'node:path';

import { overlordHome } from '../overlord-home.js';

/** Environment variable that overrides the socket path, for tests and custom setups. */
export const SOCKET_ENV = 'OVERLORD_HOOK_SOCKET';

export function socketPath(
  paths: { readonly home: string },
  platform: NodeJS.Platform = process.platform,
): string {
  const dir = overlordHome(paths.home);
  if (platform === 'win32') {
    // Named pipes live in a flat namespace, so key the name by Overlord's folder.
    const digest = createHash('sha256').update(dir).digest('hex').slice(0, 16);
    return String.raw`\\.\pipe\overlord-hook-${digest}`;
  }
  return path.join(dir, 'hook.sock');
}
