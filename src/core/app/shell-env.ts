// The environment launched runs start from. VS Code opened from the Dock has a
// bare PATH and none of the variables a shell profile exports, so read the
// login shell's environment once and layer it over the editor's.

import { loginShellEnvLaunch, parseShellEnv } from '../login-shell.js';
import type { Exec } from '../sync/exec.js';

type Env = Readonly<Record<string, string | undefined>>;

/** A slow profile should not hold up a launch for long. */
export const SHELL_ENV_TIMEOUT_MS = 10_000;

/** The login shell's environment over `env`, or `env` alone when the shell fails. */
export async function readLoginShellEnv(
  exec: Exec,
  env: Env,
  platform: NodeJS.Platform,
): Promise<Env> {
  const launch = loginShellEnvLaunch({ shell: env['SHELL'], platform });
  if (launch === null) {
    return env;
  }
  const result = await exec(launch.shellPath, launch.shellArgs, {
    timeoutMs: SHELL_ENV_TIMEOUT_MS,
  });
  const shellEnv = parseShellEnv(result.stdout);
  return shellEnv === null ? env : { ...env, ...shellEnv };
}

/** Runs `load` on the first call and hands every caller that same promise. */
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | null = null;
  return async () => {
    value ??= load();
    return value;
  };
}
