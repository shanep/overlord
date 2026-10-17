// Hooks and telemetry setup. Both change ~/.claude/settings.json, so each
// command asks first, and the app starts or stops the matching receiver after.
// The work goes through Claude Code's hooks and telemetry facets.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { claudeHooks } from '../agents/claude/hooks.js';
import { claudeTelemetry } from '../agents/claude/telemetry.js';
import type { AgentDirs, SettingsWriteResult } from '../agents/types.js';
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
    const result = await claudeHooks.install(this.dirs(), hookCommand(host.extensionPath));
    host.showInfo(
      result.changed
        ? 'Hooks installed. New Claude Code sessions report to Overlord.'
        : 'Hooks were already installed.',
    );
    await this.deps.sync();
  }

  async uninstallHooks(): Promise<void> {
    const { host } = this.deps;
    if (
      !(await host.confirm('Remove the Overlord hooks from ~/.claude/settings.json?', 'Remove'))
    ) {
      return;
    }
    const result = await claudeHooks.uninstall(this.dirs());
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
    if (this.shown(await claudeTelemetry.enable(this.dirs(), port))) {
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
    if (this.shown(await claudeTelemetry.disable(this.dirs()))) {
      host.showInfo('Telemetry is off for new Claude Code sessions.');
    }
    await this.deps.sync();
  }

  async status(): Promise<SetupStatus> {
    const { paths } = this.deps;
    let hooksInstalled = false;
    try {
      hooksInstalled = await claudeHooks.installed(this.dirs());
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

  private dirs(): AgentDirs {
    return { home: this.deps.paths.home, configDir: this.deps.paths.configDir };
  }

  /** True when the write worked, else shows its error. */
  private shown(result: SettingsWriteResult): boolean {
    if (!result.ok) {
      this.deps.host.showError(result.error);
    }
    return result.ok;
  }
}
