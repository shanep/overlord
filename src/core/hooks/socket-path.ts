// Where the hook server listens. Kept apart from server.ts so the hook script
// can import it without pulling zod and the rest of the server into its bundle.

import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ClaudePaths } from '../paths.js';

/** Environment variable that overrides the socket path, for tests and custom setups. */
export const SOCKET_ENV = 'OVERLORD_HOOK_SOCKET';

export function socketPath(
  paths: Pick<ClaudePaths, 'configDir'>,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    // Named pipes live in a flat namespace, so key the name by config dir.
    const digest = createHash('sha256').update(paths.configDir).digest('hex').slice(0, 16);
    return String.raw`\\.\pipe\overlord-hook-${digest}`;
  }
  return path.join(paths.configDir, 'overlord', 'hook.sock');
}
