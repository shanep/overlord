// The background jobs the Claude Code daemon supervises, from
// ~/.claude/daemon/roster.json (undocumented, tested against 2.1.302). A job
// stays in the roster while the daemon restarts it after a crash, so for a
// few seconds it has no process in the session registry but is still alive.

import path from 'node:path';

import { z } from 'zod';

import type { ClaudePaths } from '../paths.js';

import { hasErrorCode, readJsonFile } from './common.js';
import type { IsAlive } from './process.js';

const rosterSchema = z.object({
  supervisorPid: z.number().int(),
  workers: z.record(z.string(), z.object({ cwd: z.string().nullish() })),
});

/**
 * The folders the daemon's jobs were launched in. Empty when the daemon is
 * not running, since a dead daemon's roster restarts nothing.
 */
export async function daemonJobCwds(paths: ClaudePaths, isAlive: IsAlive): Promise<string[]> {
  let roster: z.infer<typeof rosterSchema>;
  try {
    roster = await readJsonFile(path.join(paths.configDir, 'daemon', 'roster.json'), rosterSchema);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
  if (!isAlive(roster.supervisorPid)) {
    return [];
  }
  return Object.values(roster.workers).flatMap((worker) =>
    worker.cwd === undefined || worker.cwd === null ? [] : [worker.cwd],
  );
}
