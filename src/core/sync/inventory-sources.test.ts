import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ConfigItem } from '../../shared/model.js';

import {
  BUILT_IN_AGENTS,
  builtInAgentItems,
  cloudSkillItems,
  fixedItem,
  hookItems,
  itemId,
  markdownFiles,
  mcpItems,
  memorySpecs,
  pluginItems,
  skillDirs,
} from './inventory-sources.js';
import { scratchDir, writeTree } from './test-helpers/fixtures.js';

const settingsFile: ConfigItem = {
  id: 'user:settings:settings.json',
  kind: 'settings',
  name: 'settings.json',
  scope: 'user',
  path: '/h/.claude/settings.json',
  realPath: '/r/global/settings.json',
  status: 'modified',
  repo: { root: '/r', remote: null, dirty: true },
};

describe('items', () => {
  it('builds ids and fixed items', () => {
    expect(itemId('user', 'skill', 'x')).toBe('user:skill:x');
    expect(
      fixedItem({ kind: 'agent', name: 'a', scope: 'built-in', path: null }, 'built-in'),
    ).toStrictEqual({
      id: 'built-in:agent:a',
      kind: 'agent',
      name: 'a',
      scope: 'built-in',
      path: null,
      realPath: null,
      status: 'built-in',
      repo: null,
    });
  });

  it('lists the built-in agent types', () => {
    expect(BUILT_IN_AGENTS).toStrictEqual([
      'Explore',
      'Plan',
      'general-purpose',
      'claude',
      'statusline-setup',
      'claude-code-guide',
    ]);
    expect(builtInAgentItems().map((item) => item.id)).toStrictEqual(
      BUILT_IN_AGENTS.map((name) => `built-in:agent:${name}`),
    );
  });
});

describe('hookItems', () => {
  it('copies the settings file badge onto each hook', () => {
    const settings = {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ command: 'x' }] }],
        PreToolUse: [{ matcher: 'Edit', hooks: [{ command: 'y' }, { command: 'z' }] }],
      },
    };
    expect(hookItems(settings, settingsFile)).toStrictEqual([
      {
        ...settingsFile,
        id: 'user:hook:PreToolUse:Edit:0',
        kind: 'hook',
        name: 'PreToolUse:Edit:0',
      },
      {
        ...settingsFile,
        id: 'user:hook:PreToolUse:Edit:1',
        kind: 'hook',
        name: 'PreToolUse:Edit:1',
      },
      { ...settingsFile, id: 'user:hook:Stop:*:0', kind: 'hook', name: 'Stop:*:0' },
    ]);
  });

  it('ignores malformed hook blocks', () => {
    expect(hookItems(null, settingsFile)).toStrictEqual([]);
    expect(hookItems({ hooks: [] }, settingsFile)).toStrictEqual([]);
    const odd = {
      hooks: { A: 'x', B: ['x', { matcher: 3, hooks: 'x' }, { matcher: 3, hooks: [{}] }] },
    };
    expect(hookItems(odd, settingsFile).map((item) => item.name)).toStrictEqual(['B:*:0']);
  });
});

describe('mcpItems', () => {
  it('marks servers with secrets and asks for the rest', () => {
    const items = mcpItems(
      [
        { name: 'a', config: { env: { API_KEY: 'abcdefgh1' } } },
        { name: 'b', config: { command: 'b' } },
      ],
      { scope: 'user', path: '/h/.claude.json' },
      () => ({
        status: 'external-repo',
        realPath: '/x',
        repo: { root: '/r', remote: null, dirty: false },
      }),
    );
    expect(items).toStrictEqual([
      fixedItem(
        { kind: 'mcp-server', name: 'a', scope: 'user', path: '/h/.claude.json' },
        'secret',
      ),
      {
        ...fixedItem(
          { kind: 'mcp-server', name: 'b', scope: 'user', path: '/h/.claude.json' },
          'external-repo',
        ),
        realPath: '/x',
        repo: { root: '/r', remote: null, dirty: false },
      },
    ]);
  });
});

describe('folders', () => {
  it('names markdown files by relative path', async () => {
    const dir = await scratchDir();
    await writeTree(dir, { 'a.md': '', 'x/y.md': '', 'z.txt': '' });
    expect(await markdownFiles(dir, ':')).toStrictEqual([
      { name: 'a', path: path.join(dir, 'a.md') },
      { name: 'x:y', path: path.join(dir, 'x', 'y.md') },
    ]);
  });

  it('lists skill folders but not synced or files', async () => {
    const dir = await scratchDir();
    await writeTree(dir, { 'a/SKILL.md': '', 'synced/b/c/SKILL.md': '', 'loose.md': '' });
    const skills = await skillDirs(dir);
    expect(skills.map((entry) => entry.name)).toStrictEqual(['a']);
  });

  it('finds memory folders and cloud skills', async () => {
    const dir = await scratchDir();
    await writeTree(dir, {
      'projects/-a/memory/MEMORY.md': '',
      'projects/-b/memory': 'a file, not a folder',
      'skills/synced/note.txt': '',
      'skills/synced/b1/one/SKILL.md': '',
      'skills/synced/b1/manifest.json': '',
      'skills/synced/b2/two/SKILL.md': '',
    });
    expect(await memorySpecs(path.join(dir, 'projects'))).toStrictEqual([
      {
        kind: 'memory',
        name: '-a',
        scope: 'local',
        path: path.join(dir, 'projects', '-a', 'memory'),
      },
    ]);
    const cloud = await cloudSkillItems(path.join(dir, 'skills'));
    expect(cloud.map((item) => `${item.id}=${item.status}`)).toStrictEqual([
      'cloud:skill:one=cloud-synced',
      'cloud:skill:two=cloud-synced',
    ]);
    expect(cloud[0]?.path).toBe(path.join(dir, 'skills', 'synced', 'b1', 'one'));
  });
});

describe('pluginItems', () => {
  it('reads installed and enabled plugins, tolerating odd shapes', async () => {
    const dir = await scratchDir();
    await writeTree(dir, {
      'installed_plugins.json': JSON.stringify({
        plugins: {
          'a@m': [{ installPath: path.join(dir, 'a') }],
          'b@m': [{ installPath: 3 }],
          'c@m': ['x'],
          'd@m': 'x',
          plain: [{ installPath: path.join(dir, 'plain') }],
        },
      }),
      'a/output-styles/s.md': '',
      'a/rules/r.md': '',
      'plain/agents/x.md': '',
    });
    const items = await pluginItems(dir, { enabledPlugins: { 'e@m': true, 'a@m': true } });
    expect(items.map((item) => `${item.id}|${item.path ?? ''}`)).toStrictEqual([
      `plugin:plugin:a@m|${path.join(dir, 'a')}`,
      `plugin:rule:a:r|${path.join(dir, 'a', 'rules', 'r.md')}`,
      `plugin:output-style:a:s|${path.join(dir, 'a', 'output-styles', 's.md')}`,
      'plugin:plugin:b@m|',
      'plugin:plugin:c@m|',
      'plugin:plugin:d@m|',
      'plugin:plugin:e@m|',
      `plugin:plugin:plain|${path.join(dir, 'plain')}`,
      `plugin:agent:plain:x|${path.join(dir, 'plain', 'agents', 'x.md')}`,
    ]);
    expect(items.every((item) => item.status === 'plugin' && item.scope === 'plugin')).toBe(true);
  });

  it('handles no plugin files at all', async () => {
    const dir = await scratchDir();
    expect(await pluginItems(dir, null)).toStrictEqual([]);
    await writeTree(dir, { 'installed_plugins.json': '{"plugins":[]}' });
    expect(await pluginItems(dir, { enabledPlugins: [] })).toStrictEqual([]);
  });
});
