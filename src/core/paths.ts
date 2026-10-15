// Where Claude Code and Claude Desktop keep things on disk. Every module takes
// a ClaudePaths so tests can point it at a temp directory.

import os from 'node:os';
import path from 'node:path';

export interface ClaudePaths {
  readonly home: string;
  /** ~/.claude, or CLAUDE_CONFIG_DIR when set. */
  readonly configDir: string;
  readonly projectsDir: string;
  readonly sessionsDir: string;
  readonly userSettings: string;
  readonly userClaudeMd: string;
  readonly userSkillsDir: string;
  readonly userAgentsDir: string;
  readonly userCommandsDir: string;
  readonly userRulesDir: string;
  readonly userOutputStylesDir: string;
  readonly statsCache: string;
  readonly pluginsDir: string;
  readonly ideDir: string;
  /** ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json when CLAUDE_CONFIG_DIR is set. */
  readonly claudeJson: string;
  /** Claude Desktop app data. Null on Linux, where Desktop does not run. */
  readonly desktopDir: string | null;
  /** Directory holding the managed policy CLAUDE.md and managed-settings.json. */
  readonly managedDir: string;
}

export interface PathInputs {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function managedDirFor(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return '/Library/Application Support/ClaudeCode';
  }
  if (platform === 'win32') {
    return String.raw`C:\Program Files\ClaudeCode`;
  }
  return '/etc/claude-code';
}

function desktopDirFor(platform: NodeJS.Platform, home: string): string | null {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude');
  }
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Claude');
  }
  return null;
}

export function resolveClaudePaths(inputs: PathInputs): ClaudePaths {
  const override = inputs.env['CLAUDE_CONFIG_DIR'];
  const hasOverride = override !== undefined && override !== '';
  const configDir = hasOverride ? override : path.join(inputs.home, '.claude');
  return {
    home: inputs.home,
    configDir,
    projectsDir: path.join(configDir, 'projects'),
    sessionsDir: path.join(configDir, 'sessions'),
    userSettings: path.join(configDir, 'settings.json'),
    userClaudeMd: path.join(configDir, 'CLAUDE.md'),
    userSkillsDir: path.join(configDir, 'skills'),
    userAgentsDir: path.join(configDir, 'agents'),
    userCommandsDir: path.join(configDir, 'commands'),
    userRulesDir: path.join(configDir, 'rules'),
    userOutputStylesDir: path.join(configDir, 'output-styles'),
    statsCache: path.join(configDir, 'stats-cache.json'),
    pluginsDir: path.join(configDir, 'plugins'),
    ideDir: path.join(configDir, 'ide'),
    claudeJson: hasOverride
      ? path.join(configDir, '.claude.json')
      : path.join(inputs.home, '.claude.json'),
    desktopDir: desktopDirFor(inputs.platform, inputs.home),
    managedDir: managedDirFor(inputs.platform),
  };
}

/** The real paths for this process. */
export function defaultClaudePaths(): ClaudePaths {
  return resolveClaudePaths({ home: os.homedir(), platform: process.platform, env: process.env });
}

/**
 * Claude Code's project directory name for a cwd: every character that is not
 * a letter or digit becomes "-". Names over 200 characters are cut to 200 and
 * get a hash suffix, which we cannot rebuild, so callers should match long
 * names by prefix.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replaceAll(/[^a-zA-Z0-9]/gu, '-');
}
