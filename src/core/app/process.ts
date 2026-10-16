// Process and timer helpers the app takes as dependencies. The sync module's
// Exec (which reports exit codes) is the one the app is given; the surfaces
// and harness modules want their own shapes, so they get adapters.

import { unwatchFile, watchFile } from 'node:fs';

import type { ExecFunction as HarnessExec } from '../harness/worktree.js';
import type { ExecFunction as SurfacesExec } from '../surfaces/process.js';
import type { Exec, ExecResult } from '../sync/exec.js';

/** Sends a signal to a process. */
export type KillFunction = (pid: number, signal: NodeJS.Signals) => void;

/** Runs a callback every intervalMs and returns a function that stops it. */
export type IntervalFunction = (callback: () => void, intervalMs: number) => () => void;

/** Calls onChange whenever a file changes, appears or goes away. Returns the stop function. */
export type FileWatchFunction = (file: string, onChange: () => void) => () => void;

export const defaultKill: KillFunction = (pid, signal) => {
  process.kill(pid, signal);
};

export const defaultInterval: IntervalFunction = (callback, intervalMs) => {
  const handle = setInterval(callback, intervalMs);
  handle.unref();
  return () => {
    clearInterval(handle);
  };
};

/** fs.watchFile polls, which works for files that do not exist yet and on every platform. */
export function pollingFileWatch(intervalMs: number): FileWatchFunction {
  return (file, onChange) => {
    const listener = (): void => {
      onChange();
    };
    watchFile(file, { interval: intervalMs, persistent: false }, listener);
    return () => {
      unwatchFile(file, listener);
    };
  };
}

function failure(command: string, result: ExecResult): Error {
  const detail = result.stderr.trim();
  return new Error(
    detail === '' ? `${command} exited ${String(result.code)}` : `${command} failed: ${detail}`,
  );
}

/** The surfaces modules expect a rejection on a non-zero exit. */
export function toSurfacesExec(exec: Exec): SurfacesExec {
  return async (command, args, options) => {
    const result = await exec(command, args, { timeoutMs: options.timeoutMs });
    if (result.code !== 0) {
      throw failure(command, result);
    }
    return { stdout: result.stdout };
  };
}

/** The harness worktree manager runs git in a working directory and expects a rejection on failure. */
export function toHarnessExec(exec: Exec): HarnessExec {
  return async (command, args, options) => {
    const result = await exec(command, args, { cwd: options.cwd });
    if (result.code !== 0) {
      throw failure(command, result);
    }
    return { stdout: result.stdout, stderr: result.stderr };
  };
}
