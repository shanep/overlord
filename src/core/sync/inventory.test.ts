import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ConfigItem } from '../../shared/model.js';

import type { Exec } from './exec.js';
import { scanInventory } from './inventory.js';
import {
  fakePaths,
  git,
  isolatedExec,
  repoWith,
  scratchDir,
  writeTree,
} from './test-helpers/fixtures.js';

const exec: Exec = isolatedExec();

const token = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hooks = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: 'a' },
          { type: 'command', command: 'b' },
        ],
      },
      { hooks: [{ type: 'command', command: 'c' }] },
    ],
  },
};

function badges(items: readonly ConfigItem[]): Record<string, string> {
  return Object.fromEntries(items.map((item) => [item.id, item.status]));
}

async function machine(): Promise<{ home: string; config: string; other: string }> {
  const config = await repoWith(exec, {
    'global/CLAUDE.md': 'shared',
    'global/settings.json': JSON.stringify({
      enabledPlugins: { 'p1@m': true, 'p2@m': false },
      ...hooks,
    }),
    'mcp.json': JSON.stringify({ mcpServers: { repoed: { command: 'r' } } }),
  });
  await git(exec, config, ['remote', 'add', 'origin', 'git@github.com:me/claude-config.git']);
  const other = await repoWith(exec, { 'skills/canvas/SKILL.md': 'c' });
  await git(exec, other, ['remote', 'add', 'origin', 'git@github.com:me/edutools']);
  const home = await scratchDir();
  const claude = path.join(home, '.claude');
  await writeTree(home, {
    '.claude/keybindings.json': '[]',
    '.claude/rules/a.md': 'a',
    '.claude/rules/sub/b.md': 'b',
    '.claude/rules/notes.txt': 'skip',
    '.claude/skills/local-skill/SKILL.md': 'l',
    '.claude/skills/synced/.bucket-1': '',
    '.claude/skills/synced/bucket-1/manifest.json': '{}',
    '.claude/skills/synced/bucket-1/docx/SKILL.md': 'd',
    '.claude/agents/rev.md': 'r',
    '.claude/commands/git/commit.md': 'c',
    '.claude/output-styles/terse.md': 't',
    '.claude/projects/-x/memory/MEMORY.md': 'm',
    '.claude/projects/-y/abc.jsonl': '{}',
    '.claude/plugins/installed_plugins.json': JSON.stringify({
      plugins: { 'p1@m': [{ installPath: path.join(claude, 'plugins', 'cache', 'p1') }] },
    }),
    '.claude/plugins/cache/p1/skills/ps/SKILL.md': 's',
    '.claude/plugins/cache/p1/agents/pa.md': 'a',
    '.claude/plugins/cache/p1/commands/pc.md': 'c',
    '.claude.json': JSON.stringify({
      mcpServers: {
        gh: { command: 'npx', env: { GITHUB_TOKEN: 'abcdefgh123' } },
        plain: { command: 'p' },
        repoed: { command: 'r' },
      },
      oauthAccount: { emailAddress: 'never@read.it' },
    }),
    'managed/CLAUDE.md': 'policy',
    'managed/managed-settings.json': '{}',
    'managed/managed-mcp.json': JSON.stringify({ mcpServers: { corp: { url: 'https://corp' } } }),
  });
  await symlink(path.join(config, 'global', 'CLAUDE.md'), path.join(claude, 'CLAUDE.md'));
  await symlink(path.join(config, 'global', 'settings.json'), path.join(claude, 'settings.json'));
  await symlink(path.join(other, 'skills', 'canvas'), path.join(claude, 'skills', 'canvas'));
  return { home, config, other };
}

describe('scanInventory', () => {
  it('badges everything in user, managed, plugin, cloud and built-in scope', async () => {
    const { home, config, other } = await machine();
    const paths = fakePaths(home);
    const items = await scanInventory({ paths, exec, configRepoRoot: config, workspace: null });
    expect(badges(items)).toStrictEqual({
      'managed:claude-md:CLAUDE.md': 'managed',
      'managed:settings:managed-settings.json': 'managed',
      'managed:mcp-server:corp': 'managed',
      'user:claude-md:CLAUDE.md': 'versioned',
      'user:keybindings:keybindings.json': 'local-only',
      'user:settings:settings.json': 'versioned',
      'user:hook:PreToolUse:Bash:0': 'versioned',
      'user:hook:PreToolUse:Bash:1': 'versioned',
      'user:hook:PreToolUse:*:2': 'versioned',
      'user:rule:a': 'local-only',
      'user:rule:sub/b': 'local-only',
      'user:skill:canvas': 'external-repo',
      'user:skill:local-skill': 'local-only',
      'user:agent:rev': 'local-only',
      'user:command:git:commit': 'local-only',
      'user:output-style:terse': 'local-only',
      'user:mcp-server:gh': 'secret',
      'user:mcp-server:plain': 'local-only',
      'user:mcp-server:repoed': 'versioned',
      'plugin:plugin:p1@m': 'plugin',
      'plugin:skill:p1:ps': 'plugin',
      'plugin:agent:p1:pa': 'plugin',
      'plugin:command:p1:pc': 'plugin',
      'plugin:plugin:p2@m': 'plugin',
      'local:memory:-x': 'local-only',
      'cloud:skill:docx': 'cloud-synced',
      'built-in:agent:Explore': 'built-in',
      'built-in:agent:Plan': 'built-in',
      'built-in:agent:general-purpose': 'built-in',
      'built-in:agent:claude': 'built-in',
      'built-in:agent:statusline-setup': 'built-in',
      'built-in:agent:claude-code-guide': 'built-in',
    });
    expect(items.map((item) => item.id)[3]).toBe('user:claude-md:CLAUDE.md');
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get('user:claude-md:CLAUDE.md')).toStrictEqual({
      id: 'user:claude-md:CLAUDE.md',
      kind: 'claude-md',
      name: 'CLAUDE.md',
      scope: 'user',
      path: path.join(home, '.claude', 'CLAUDE.md'),
      realPath: path.join(config, 'global', 'CLAUDE.md'),
      status: 'versioned',
      repo: { root: config, remote: 'git@github.com:me/claude-config.git', dirty: false },
    });
    expect(byId.get('user:skill:canvas')?.repo).toStrictEqual({
      root: other,
      remote: 'git@github.com:me/edutools',
      dirty: false,
    });
    expect(byId.get('user:hook:PreToolUse:Bash:0')).toMatchObject({
      kind: 'hook',
      name: 'PreToolUse:Bash:0',
      scope: 'user',
      path: path.join(home, '.claude', 'settings.json'),
    });
    expect(byId.get('user:mcp-server:gh')).toMatchObject({
      path: paths.claudeJson,
      realPath: null,
      repo: null,
    });
    expect(byId.get('plugin:plugin:p1@m')?.path).toBe(
      path.join(home, '.claude', 'plugins', 'cache', 'p1'),
    );
    expect(byId.get('plugin:plugin:p2@m')?.path).toBeNull();
    expect(byId.get('local:memory:-x')?.path).toBe(
      path.join(home, '.claude', 'projects', '-x', 'memory'),
    );
    expect(byId.get('cloud:skill:docx')).toMatchObject({
      scope: 'cloud',
      kind: 'skill',
      repo: null,
    });
    expect(byId.get('built-in:agent:Plan')).toMatchObject({ path: null, scope: 'built-in' });
    expect(JSON.stringify(items)).not.toContain('never@read.it');
  });

  it('marks config repo files with changes as modified, and handles no config repo', async () => {
    const { home, config } = await machine();
    await writeFile(path.join(config, 'global', 'CLAUDE.md'), 'edited by Claude');
    const items = await scanInventory({
      paths: fakePaths(home),
      exec,
      configRepoRoot: config,
      workspace: null,
    });
    expect(badges(items)['user:claude-md:CLAUDE.md']).toBe('modified');
    expect(badges(items)['user:settings:settings.json']).toBe('versioned');
    const loose = await scanInventory({
      paths: fakePaths(home),
      exec,
      configRepoRoot: null,
      workspace: null,
    });
    expect(badges(loose)['user:claude-md:CLAUDE.md']).toBe('external-repo');
    expect(badges(loose)['user:mcp-server:repoed']).toBe('local-only');
  });

  it('scans an empty home without failing', async () => {
    const home = await scratchDir();
    const items = await scanInventory({
      paths: fakePaths(home),
      exec,
      configRepoRoot: null,
      workspace: null,
    });
    expect(items.map((item) => item.status)).toStrictEqual(
      Array.from({ length: 6 }, () => 'built-in'),
    );
  });

  it('adds project scope items for a workspace', async () => {
    const home = await scratchDir();
    const workspace = await repoWith(exec, {
      '.gitignore': 'CLAUDE.local.md\n.claude/settings.local.json\n',
      'CLAUDE.md': 'p',
      '.claude/CLAUDE.md': 'p2',
      '.claude/settings.json': JSON.stringify(hooks),
      '.claude/skills/build/SKILL.md': 'b',
      '.claude/agents/tester.md': 't',
      '.claude/rules/style.md': 's',
      '.claude/commands/ship.md': 's',
      '.claude/output-styles/brief.md': 'b',
      '.mcp.json': JSON.stringify({
        mcpServers: {
          web: { url: 'https://w' },
          sec: { headers: { Authorization: `Bearer ${token}` } },
        },
      }),
    });
    await writeTree(workspace, { 'CLAUDE.local.md': 'mine', '.claude/settings.local.json': '{}' });
    await mkdir(path.join(workspace, '.claude', 'skills', 'not-a-skill.md'), { recursive: true });
    const items = await scanInventory({
      paths: fakePaths(home),
      exec,
      configRepoRoot: null,
      workspace,
    });
    const project = Object.fromEntries(
      Object.entries(badges(items)).filter(
        ([id]) => id.startsWith('project:') || id.startsWith('local:'),
      ),
    );
    expect(project).toStrictEqual({
      'project:claude-md:CLAUDE.md': 'external-repo',
      'project:claude-md:.claude/CLAUDE.md': 'external-repo',
      'local:claude-md:CLAUDE.local.md': 'local-only',
      'project:settings:settings.json': 'external-repo',
      'project:hook:PreToolUse:Bash:0': 'external-repo',
      'project:hook:PreToolUse:Bash:1': 'external-repo',
      'project:hook:PreToolUse:*:2': 'external-repo',
      'local:settings:settings.local.json': 'local-only',
      'project:rule:style': 'external-repo',
      'project:skill:build': 'external-repo',
      'project:skill:not-a-skill.md': 'external-repo',
      'project:agent:tester': 'external-repo',
      'project:command:ship': 'external-repo',
      'project:output-style:brief': 'external-repo',
      'project:mcp-server:sec': 'secret',
      'project:mcp-server:web': 'external-repo',
    });
    const web = items.find((item) => item.id === 'project:mcp-server:web');
    expect(web?.repo).toStrictEqual({ root: workspace, remote: null, dirty: false });
    expect(web?.path).toBe(path.join(workspace, '.mcp.json'));
  });

  it('skips the .mcp.json lookup when a workspace has no servers', async () => {
    const home = await scratchDir();
    const workspace = await scratchDir();
    const items = await scanInventory({
      paths: fakePaths(home),
      exec,
      configRepoRoot: null,
      workspace,
    });
    expect(items.filter((item) => item.scope === 'project')).toStrictEqual([]);
  });
});
