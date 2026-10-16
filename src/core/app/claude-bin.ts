// Which claude binary Overlord runs, and with what environment, when it runs
// claude outside a terminal tab: SDK runs, the jobs poll and background starts.

import { findOnPath } from '../find-on-path.js';
import { mergeEnv } from '../harness/options.js';

import type { ClaudeCli } from './runtime.js';

/**
 * The binary SDK runs use. The host only searched the editor's PATH, so a bare
 * name is looked up again on the login shell's. A bare `claude` found nowhere
 * leaves the SDK to its bundled CLI.
 */
export function executableFor(
  claudePath: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string | null {
  const name = claudePath.trim() === '' ? 'claude' : claudePath.trim();
  const found = findOnPath({ name, pathValue: env['PATH'], platform });
  if (found !== null) {
    return found;
  }
  return name === 'claude' ? null : name;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Resolves the CLI against the login shell's environment on each call, so a
 * settings change takes effect. A bare claude found nowhere is left to PATH.
 */
export function cliLoader(
  settings: { readonly claudePath: string },
  loginEnv: () => Promise<Env>,
  platform: NodeJS.Platform,
): () => Promise<ClaudeCli> {
  return async () => {
    const env = await loginEnv();
    return {
      bin: executableFor(settings.claudePath, env, platform) ?? 'claude',
      env: mergeEnv(env, {}),
    };
  };
}
