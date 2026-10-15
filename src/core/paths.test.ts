import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultClaudePaths, encodeProjectDir, resolveClaudePaths } from './paths.js';

describe('resolveClaudePaths', () => {
  it('uses ~/.claude and ~/.claude.json by default on macOS', () => {
    const paths = resolveClaudePaths({ home: '/Users/me', platform: 'darwin', env: {} });
    expect(paths.configDir).toBe('/Users/me/.claude');
    expect(paths.projectsDir).toBe('/Users/me/.claude/projects');
    expect(paths.sessionsDir).toBe('/Users/me/.claude/sessions');
    expect(paths.userSettings).toBe('/Users/me/.claude/settings.json');
    expect(paths.userClaudeMd).toBe('/Users/me/.claude/CLAUDE.md');
    expect(paths.userSkillsDir).toBe('/Users/me/.claude/skills');
    expect(paths.userAgentsDir).toBe('/Users/me/.claude/agents');
    expect(paths.userCommandsDir).toBe('/Users/me/.claude/commands');
    expect(paths.userRulesDir).toBe('/Users/me/.claude/rules');
    expect(paths.userOutputStylesDir).toBe('/Users/me/.claude/output-styles');
    expect(paths.statsCache).toBe('/Users/me/.claude/stats-cache.json');
    expect(paths.pluginsDir).toBe('/Users/me/.claude/plugins');
    expect(paths.ideDir).toBe('/Users/me/.claude/ide');
    expect(paths.claudeJson).toBe('/Users/me/.claude.json');
    expect(paths.desktopDir).toBe('/Users/me/Library/Application Support/Claude');
    expect(paths.managedDir).toBe('/Library/Application Support/ClaudeCode');
    expect(paths.home).toBe('/Users/me');
  });

  it('honors CLAUDE_CONFIG_DIR for the config dir and .claude.json', () => {
    const paths = resolveClaudePaths({
      home: '/home/me',
      platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: '/tmp/cc' },
    });
    expect(paths.configDir).toBe('/tmp/cc');
    expect(paths.claudeJson).toBe('/tmp/cc/.claude.json');
    expect(paths.desktopDir).toBeNull();
    expect(paths.managedDir).toBe('/etc/claude-code');
  });

  it('ignores an empty CLAUDE_CONFIG_DIR', () => {
    const paths = resolveClaudePaths({
      home: '/home/me',
      platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: '' },
    });
    expect(paths.configDir).toBe('/home/me/.claude');
  });

  it('knows the Windows locations', () => {
    const paths = resolveClaudePaths({ home: 'C:/Users/me', platform: 'win32', env: {} });
    expect(paths.managedDir).toBe(String.raw`C:\Program Files\ClaudeCode`);
    expect(paths.desktopDir).toBe(path.join('C:/Users/me', 'AppData', 'Roaming', 'Claude'));
  });
});

describe('defaultClaudePaths', () => {
  it('resolves against the real home directory', () => {
    expect(defaultClaudePaths().projectsDir.endsWith('projects')).toBe(true);
  });
});

describe('encodeProjectDir', () => {
  it('replaces every non alphanumeric character with a dash', () => {
    expect(encodeProjectDir('/Users/shane/repos/overlord')).toBe('-Users-shane-repos-overlord');
    expect(encodeProjectDir('/a b/c.d_e')).toBe('-a-b-c-d-e');
  });
});
