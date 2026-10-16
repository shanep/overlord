// Process helpers that tests replace. Nothing here starts a Claude session:
// the only command run is the read-only `claude agents --json`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { hasErrorCode } from './common.js';

interface ExecOptions {
  readonly timeoutMs: number;
}

interface ExecResult {
  readonly stdout: string;
}

export type ExecFunction = (
  command: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>;

/** True when a process with this pid exists. */
export type IsAlive = (pid: number) => boolean;

export type KillFunction = (pid: number, signal: number) => void;

const execFileAsync = promisify(execFile);

// Enough for thousands of sessions in `claude agents --json --all`.
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export const defaultExec: ExecFunction = async (command, args, options) => {
  const { stdout } = await execFileAsync(command, [...args], {
    timeout: options.timeoutMs,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER_BYTES,
  });
  return { stdout };
};

function realKill(pid: number, signal: number): void {
  process.kill(pid, signal);
}

/**
 * Build a liveness check on top of kill(pid, 0). EPERM means the process
 * exists but belongs to someone else, so it still counts as alive.
 */
export function makeIsAlive(kill: KillFunction = realKill): IsAlive {
  return (pid) => {
    // kill(0) and negative ids address process groups, not one process.
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      kill(pid, 0);
      return true;
    } catch (error) {
      return hasErrorCode(error, 'EPERM');
    }
  };
}
