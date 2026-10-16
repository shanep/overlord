// Runs external programs (git, claude) without a shell. Everything in sync
// takes an Exec so tests can record or fake calls.

import { execFile, type ExecFileException } from 'node:child_process';

export interface ExecOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Extra variables layered over the parent environment. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Exec = (
  command: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>;

/** Exit code reported when the program could not be started (shell convention). */
export const NOT_FOUND_CODE = 127;
/** Exit code reported when the program ran past its timeout (coreutils convention). */
export const TIMEOUT_CODE = 124;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export function exitCodeOf(error: ExecFileException | null): number {
  if (error === null) {
    return 0;
  }
  if (typeof error.code === 'number') {
    return error.code;
  }
  if (error.killed === true) {
    return TIMEOUT_CODE;
  }
  if (typeof error.code === 'string') {
    return NOT_FOUND_CODE;
  }
  return 1;
}

async function runWithNode(
  command: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: { ...process.env, ...options.env },
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = exitCodeOf(error);
        const message = error !== null && stderr === '' ? error.message : stderr;
        resolve({ code, stdout, stderr: message });
      },
    );
  });
}

export function createNodeExec(): Exec {
  return runWithNode;
}
