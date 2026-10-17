// The Codex CLI part of hooks and telemetry setup. Each step asks first, and
// only when Codex has its folder on this machine.
//
// Codex runs a hook only once the user trusts it in /hooks, and it ties that
// trust to a hash of the hook. So the hook command points at a copy of the
// relay in ~/.overlord/bin, which stays the same in every version of
// Overlord, and the user trusts the hooks once. Overlord does not grant that
// trust itself.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { codexHooks } from '../agents/codex/hooks.js';
import { codexInstructions } from '../agents/codex/instructions.js';
import { codexTelemetry } from '../agents/codex/telemetry.js';
import type { AgentDirs, SettingsWriteResult, ShellEnv } from '../agents/types.js';
import { installStableRelay } from '../hooks/stable-relay.js';
import type { ClaudePaths } from '../paths.js';

import type { HostPort } from './host-port.js';

export interface CodexSetupDeps {
  readonly paths: ClaudePaths;
  readonly host: HostPort;
  /** Where to look for CODEX_HOME. */
  readonly env: ShellEnv;
}

/** What setup tells the user to do in Codex after the hooks go in. */
export const TRUST_STEP =
  'Open /hooks in Codex once and trust the Overlord hooks, or Codex skips them.';

function dirsOf(deps: CodexSetupDeps): AgentDirs {
  const { home } = deps.paths;
  return {
    home,
    configDir: codexInstructions.configDir({ home, env: deps.env, claude: deps.paths }),
  };
}

/** A path as the user knows it, with ~ for the home folder. */
function shown(deps: CodexSetupDeps, file: string): string {
  const { home } = deps.paths;
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

async function isFolder(dir: string): Promise<boolean> {
  try {
    const info = await stat(dir);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** True when the write worked, else shows its error. */
function done(deps: CodexSetupDeps, result: SettingsWriteResult): boolean {
  if (!result.ok) {
    deps.host.showError(result.error);
  }
  return result.ok;
}

/** True when the user said yes. */
export async function installCodexHooks(deps: CodexSetupDeps): Promise<boolean> {
  const { host } = deps;
  const dirs = dirsOf(deps);
  if (!(await isFolder(dirs.configDir))) {
    return false;
  }
  const file = shown(deps, path.join(dirs.configDir, 'hooks.json'));
  const question = `Overlord will add its hooks to ${file} for Codex CLI. Your own hooks stay. Codex then asks you to trust them once in /hooks. Continue?`;
  if (!(await host.confirm(question, 'Install'))) {
    return false;
  }
  const before = await codexHooks.installed(dirs).catch(() => false);
  let command: string;
  try {
    command = await installStableRelay(host.extensionPath, dirs.home);
  } catch (error) {
    host.showError(
      `Cannot copy the hook relay: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  const result = await codexHooks.install(dirs, command);
  if (!result.changed) {
    host.showInfo('Codex CLI hooks were already installed.');
  } else if (before) {
    host.showInfo(`The Overlord hook command for Codex CLI changed. ${TRUST_STEP}`);
  } else {
    host.showInfo(`Hooks installed for Codex CLI. ${TRUST_STEP}`);
  }
  return true;
}

/** Asks only when Overlord's Codex hooks are there. */
export async function uninstallCodexHooks(deps: CodexSetupDeps): Promise<boolean> {
  const { host } = deps;
  const dirs = dirsOf(deps);
  if (!(await codexHooks.installed(dirs).catch(() => false))) {
    return false;
  }
  const file = shown(deps, path.join(dirs.configDir, 'hooks.json'));
  if (!(await host.confirm(`Remove the Overlord hooks from ${file}?`, 'Remove'))) {
    return false;
  }
  const result = await codexHooks.uninstall(dirs);
  host.showInfo(
    result.changed ? 'Codex CLI hooks removed.' : 'No Overlord Codex CLI hooks were installed.',
  );
  return true;
}

/** True when the user said yes. Sessions Overlord starts export without this, while the receiver runs. */
export async function enableCodexTelemetry(deps: CodexSetupDeps, port: number): Promise<boolean> {
  const { host } = deps;
  const dirs = dirsOf(deps);
  if (!(await isFolder(dirs.configDir))) {
    return false;
  }
  const file = shown(deps, path.join(dirs.configDir, 'config.toml'));
  const question = `Overlord will add an [otel] block to ${file} so Codex CLI sessions you start yourself send their logs to 127.0.0.1:${String(port)}. Prompts stay off, and Overlord drops your email and account id from what it gets. The rest of the file stays as it is, with a copy in config.toml.bak. Continue?`;
  if (!(await host.confirm(question, 'Enable'))) {
    return false;
  }
  if (done(deps, await codexTelemetry.enable(dirs, port))) {
    host.showInfo('Telemetry is on for new Codex CLI sessions.');
  }
  return true;
}

/** Asks only when Overlord's [otel] block is there. */
export async function disableCodexTelemetry(deps: CodexSetupDeps): Promise<boolean> {
  const { host } = deps;
  const dirs = dirsOf(deps);
  if ((await codexTelemetry.enabled?.(dirs)) !== true) {
    return false;
  }
  const file = shown(deps, path.join(dirs.configDir, 'config.toml'));
  if (!(await host.confirm(`Remove Overlord's [otel] block from ${file}?`, 'Disable'))) {
    return false;
  }
  if (done(deps, await codexTelemetry.disable(dirs))) {
    host.showInfo('Telemetry is off for new Codex CLI sessions.');
  }
  return true;
}
