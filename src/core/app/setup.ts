// Hooks and telemetry setup. Both change ~/.claude/settings.json, so each
// command asks first, and the app starts or stops the matching receiver after.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { installHooks, isInstalled, uninstallHooks } from '../hooks/install.js';
import { writeSetting } from '../knobs/write.js';
import { TELEMETRY_ENV_KEYS, telemetryEnv } from '../otel/env.js';
import type { ClaudePaths } from '../paths.js';

import type { AppError } from './errors.js';
import type { HostPort } from './host-port.js';
import { telemetryActive, userSettingsEnv } from './settings-view.js';

export interface SetupStatus {
  readonly hooksInstalled: boolean;
  readonly telemetryEnabled: boolean;
  /** Another Overlord window owns the hook socket, so this one only watches transcripts. */
  readonly observerMode: boolean;
  readonly errors: readonly AppError[];
}

export interface SetupDeps {
  readonly paths: ClaudePaths;
  readonly host: HostPort;
  /** Starts or stops the hook server and OTLP receiver to match the settings file. */
  readonly sync: () => Promise<void>;
  readonly observerMode: () => boolean;
  readonly errors: () => readonly AppError[];
}

/** The command every hook runs. It must contain "overlord-hook". */
export function hookCommand(extensionPath: string): string {
  return `node "${path.join(extensionPath, 'dist', 'overlord-hook.cjs')}"`;
}

export class SetupCommands {
  constructor(private readonly deps: SetupDeps) {}

  async installHooks(): Promise<void> {
    const { host, paths } = this.deps;
    const question =
      'Overlord will add its hook to every event in ~/.claude/settings.json. Your own hooks stay. Continue?';
    if (!(await host.confirm(question, 'Install'))) {
      return;
    }
    await mkdir(path.dirname(paths.userSettings), { recursive: true });
    const result = await installHooks({
      settingsFile: paths.userSettings,
      hookCommand: hookCommand(host.extensionPath),
    });
    host.showInfo(
      result.changed
        ? 'Hooks installed. New Claude Code sessions report to Overlord.'
        : 'Hooks were already installed.',
    );
    await this.deps.sync();
  }

  async uninstallHooks(): Promise<void> {
    const { host, paths } = this.deps;
    if (
      !(await host.confirm('Remove the Overlord hooks from ~/.claude/settings.json?', 'Remove'))
    ) {
      return;
    }
    const result = await uninstallHooks({ settingsFile: paths.userSettings });
    host.showInfo(result.changed ? 'Hooks removed.' : 'No Overlord hooks were installed.');
    await this.deps.sync();
  }

  async enableTelemetry(): Promise<void> {
    const { host } = this.deps;
    const port = host.settings.telemetryPort;
    const question = `Overlord will set the telemetry env vars in ~/.claude/settings.json so Claude Code sends metrics to 127.0.0.1:${String(port)}. Prompts and tool details stay off. Continue?`;
    if (!(await host.confirm(question, 'Enable'))) {
      return;
    }
    if (await this.write(Object.entries(telemetryEnv(port)))) {
      host.showInfo('Telemetry is on for new Claude Code sessions.');
    }
    await this.deps.sync();
  }

  async disableTelemetry(): Promise<void> {
    const { host } = this.deps;
    const question = 'Remove the telemetry env vars from ~/.claude/settings.json?';
    if (!(await host.confirm(question, 'Disable'))) {
      return;
    }
    if (await this.write(TELEMETRY_ENV_KEYS.map((key) => [key, undefined]))) {
      host.showInfo('Telemetry is off for new Claude Code sessions.');
    }
    await this.deps.sync();
  }

  async status(): Promise<SetupStatus> {
    const { paths } = this.deps;
    let hooksInstalled = false;
    try {
      hooksInstalled = await isInstalled({ settingsFile: paths.userSettings });
    } catch {
      // A settings file in a shape the installer does not know has no Overlord hooks.
    }
    return {
      hooksInstalled,
      telemetryEnabled: telemetryActive(await userSettingsEnv(paths)),
      observerMode: this.deps.observerMode(),
      errors: this.deps.errors(),
    };
  }

  /** Writes each env key in turn. Stops and shows the error at the first failure. */
  private async write(
    entries: readonly (readonly [string, string | undefined])[],
  ): Promise<boolean> {
    for (const [key, value] of entries) {
      const result = await writeSetting({
        file: this.deps.paths.userSettings,
        keyPath: `env.${key}`,
        value,
      });
      if (!result.ok) {
        this.deps.host.showError(result.error);
        return false;
      }
    }
    return true;
  }
}
