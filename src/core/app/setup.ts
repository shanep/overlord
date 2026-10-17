// Hooks and telemetry setup. Both change ~/.claude/settings.json, so each
// command asks first, and the app starts or stops the matching receiver after.
// The work goes through Claude Code's hooks and telemetry facets. When
// Copilot CLI is set up on this machine, the hooks commands also offer its
// hooks file, with a question of its own, and Codex CLI gets its hooks and
// its [otel] block the same way (setup-codex.ts).

import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { claudeHooks } from '../agents/claude/hooks.js';
import { claudeTelemetry } from '../agents/claude/telemetry.js';
import { copilotDirs, copilotHooks, hooksFile } from '../agents/copilot/hooks.js';
import type { AgentDirs, SettingsWriteResult, ShellEnv } from '../agents/types.js';
import type { ClaudePaths } from '../paths.js';

import type { AppError } from './errors.js';
import type { HostPort } from './host-port.js';
import { telemetryActive, userSettingsEnv } from './settings-view.js';
import type { CodexSetupDeps } from './setup-codex.js';
import {
  disableCodexTelemetry,
  enableCodexTelemetry,
  installCodexHooks,
  uninstallCodexHooks,
} from './setup-codex.js';

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
  /** Where to look for COPILOT_HOME, the same env Sources reads. Left out, Copilot's folder is ~/.copilot. */
  readonly env?: ShellEnv;
}

/** The command every hook runs. It must contain "overlord-hook". */
export function hookCommand(extensionPath: string): string {
  return `node "${path.join(extensionPath, 'dist', 'overlord-hook.cjs')}"`;
}

/** True when the path is a folder. Copilot makes its folder the first time it runs. */
async function isFolder(dir: string): Promise<boolean> {
  try {
    const info = await stat(dir);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export class SetupCommands {
  constructor(private readonly deps: SetupDeps) {}

  async installHooks(): Promise<void> {
    const claude = await this.installClaudeHooks();
    const copilot = await this.installCopilotHooks();
    const codex = await installCodexHooks(this.codex());
    if (claude || copilot || codex) {
      await this.deps.sync();
    }
  }

  async uninstallHooks(): Promise<void> {
    const claude = await this.uninstallClaudeHooks();
    const copilot = await this.uninstallCopilotHooks();
    const codex = await uninstallCodexHooks(this.codex());
    if (claude || copilot || codex) {
      await this.deps.sync();
    }
  }

  /** True when the user said yes. */
  private async installClaudeHooks(): Promise<boolean> {
    const { host, paths } = this.deps;
    const question =
      'Overlord will add its hook to every event in ~/.claude/settings.json. Your own hooks stay. Continue?';
    if (!(await host.confirm(question, 'Install'))) {
      return false;
    }
    await mkdir(path.dirname(paths.userSettings), { recursive: true });
    const result = await claudeHooks.install(this.dirs(), hookCommand(host.extensionPath));
    host.showInfo(
      result.changed
        ? 'Hooks installed. New Claude Code sessions report to Overlord.'
        : 'Hooks were already installed.',
    );
    return true;
  }

  /** Asks only when Copilot has its folder here. True when the user said yes. */
  private async installCopilotHooks(): Promise<boolean> {
    const { host } = this.deps;
    const dirs = this.copilotDirs();
    if (!(await isFolder(dirs.configDir))) {
      return false;
    }
    const file = this.copilotFile();
    const question = `Overlord will add its own hook file, ${file}, for Copilot CLI. Your own hook files stay. Continue?`;
    if (!(await host.confirm(question, 'Install'))) {
      return false;
    }
    const result = await copilotHooks.install(dirs, hookCommand(host.extensionPath));
    host.showInfo(
      result.changed
        ? 'Hooks installed. New Copilot CLI sessions report to Overlord.'
        : 'Copilot CLI hooks were already installed.',
    );
    return true;
  }

  private async uninstallClaudeHooks(): Promise<boolean> {
    const { host } = this.deps;
    if (
      !(await host.confirm('Remove the Overlord hooks from ~/.claude/settings.json?', 'Remove'))
    ) {
      return false;
    }
    const result = await claudeHooks.uninstall(this.dirs());
    host.showInfo(result.changed ? 'Hooks removed.' : 'No Overlord hooks were installed.');
    return true;
  }

  /** Asks only when Overlord's Copilot hook file is there. */
  private async uninstallCopilotHooks(): Promise<boolean> {
    const { host } = this.deps;
    const dirs = this.copilotDirs();
    if (!(await copilotHooks.installed(dirs))) {
      return false;
    }
    if (!(await host.confirm(`Remove the Overlord hook file ${this.copilotFile()}?`, 'Remove'))) {
      return false;
    }
    const result = await copilotHooks.uninstall(dirs);
    host.showInfo(
      result.changed
        ? 'Copilot CLI hooks removed.'
        : 'No Overlord Copilot CLI hooks were installed.',
    );
    return true;
  }

  async enableTelemetry(): Promise<void> {
    const claude = await this.enableClaudeTelemetry();
    const codex = await enableCodexTelemetry(this.codex(), this.deps.host.settings.telemetryPort);
    if (claude || codex) {
      await this.deps.sync();
    }
  }

  async disableTelemetry(): Promise<void> {
    const claude = await this.disableClaudeTelemetry();
    const codex = await disableCodexTelemetry(this.codex());
    if (claude || codex) {
      await this.deps.sync();
    }
  }

  /** True when the user said yes. */
  private async enableClaudeTelemetry(): Promise<boolean> {
    const { host } = this.deps;
    const port = host.settings.telemetryPort;
    const question = `Overlord will set the telemetry env vars in ~/.claude/settings.json so Claude Code sends metrics to 127.0.0.1:${String(port)}. Prompts and tool details stay off. Continue?`;
    if (!(await host.confirm(question, 'Enable'))) {
      return false;
    }
    if (this.shown(await claudeTelemetry.enable(this.dirs(), port))) {
      host.showInfo('Telemetry is on for new Claude Code sessions.');
    }
    return true;
  }

  /** True when the user said yes. */
  private async disableClaudeTelemetry(): Promise<boolean> {
    const { host } = this.deps;
    const question = 'Remove the telemetry env vars from ~/.claude/settings.json?';
    if (!(await host.confirm(question, 'Disable'))) {
      return false;
    }
    if (this.shown(await claudeTelemetry.disable(this.dirs()))) {
      host.showInfo('Telemetry is off for new Claude Code sessions.');
    }
    return true;
  }

  private codex(): CodexSetupDeps {
    const { paths, host, env } = this.deps;
    return { paths, host, env: env ?? {} };
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

  private copilotDirs(): AgentDirs {
    return copilotDirs(this.deps.paths.home, this.deps.env ?? {});
  }

  /** The hooks file as the user knows it, with ~ for the home folder. */
  private copilotFile(): string {
    const file = hooksFile(this.copilotDirs());
    const { home } = this.deps.paths;
    return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
  }

  /** True when the write worked, else shows its error. */
  private shown(result: SettingsWriteResult): boolean {
    if (!result.ok) {
      this.deps.host.showError(result.error);
    }
    return result.ok;
  }
}
