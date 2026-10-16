import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Exec } from './exec.js';
import { stableJson } from './json.js';
import { emptyManifest, type Manifest } from './manifest.js';
import {
  checkoutOf,
  linksTo,
  matchesTemplate,
  planApply,
  planCopy,
  planLink,
  prepareTarget,
  repoName,
} from './plan.js';
import {
  bareRemoteWith,
  fakePaths,
  isolatedExec,
  scratchDir,
  writeTree,
} from './test-helpers/fixtures.js';

const exec: Exec = isolatedExec();

describe('helpers', () => {
  it('knows when a link already points at its source', async () => {
    const dir = await scratchDir();
    await writeTree(dir, { 'a.md': 'a', 'b.md': 'b', 'plain.md': 'p' });
    await symlink(path.join(dir, 'a.md'), path.join(dir, 'abs'));
    await symlink('a.md', path.join(dir, 'rel'));
    expect(await linksTo(path.join(dir, 'abs'), path.join(dir, 'a.md'))).toBe(true);
    expect(await linksTo(path.join(dir, 'rel'), path.join(dir, 'a.md'))).toBe(true);
    expect(await linksTo(path.join(dir, 'abs'), path.join(dir, 'b.md'))).toBe(false);
    expect(await linksTo(path.join(dir, 'plain.md'), path.join(dir, 'plain.md'))).toBe(false);
    expect(await linksTo(path.join(dir, 'missing'), path.join(dir, 'a.md'))).toBe(false);
  });

  it('prepares a target with mkdir and backup only when needed', async () => {
    const dir = await scratchDir();
    await writeTree(dir, { 'x/there.md': '' });
    expect(await prepareTarget(path.join(dir, 'new', 'a.md'))).toStrictEqual([
      { kind: 'mkdir', path: path.join(dir, 'new') },
    ]);
    expect(await prepareTarget(path.join(dir, 'x', 'there.md'))).toStrictEqual([
      { kind: 'backup', path: path.join(dir, 'x', 'there.md') },
    ]);
    expect(await prepareTarget(path.join(dir, 'x', 'new.md'))).toStrictEqual([]);
  });

  it('plans links and copies', async () => {
    const dir = await scratchDir();
    await writeTree(dir, { 'src/a.md': 'a', 'same.md': 'a', 'other.md': 'o' });
    const source = path.join(dir, 'src', 'a.md');
    await symlink(source, path.join(dir, 'linked'));
    expect(await planLink(source, path.join(dir, 'linked'))).toStrictEqual([]);
    expect(await planLink(source, path.join(dir, 'other.md'))).toStrictEqual([
      { kind: 'backup', path: path.join(dir, 'other.md') },
      { kind: 'link', source, target: path.join(dir, 'other.md') },
    ]);
    expect(await planCopy(source, path.join(dir, 'same.md'))).toStrictEqual([]);
    expect(await planCopy(source, path.join(dir, 'other.md'))).toStrictEqual([
      { kind: 'backup', path: path.join(dir, 'other.md') },
      { kind: 'copy', source, target: path.join(dir, 'other.md') },
    ]);
    // A link to the same content is still replaced by a real copy.
    expect(await planCopy(source, path.join(dir, 'linked'))).toStrictEqual([
      { kind: 'backup', path: path.join(dir, 'linked') },
      { kind: 'copy', source, target: path.join(dir, 'linked') },
    ]);
  });

  it('names checkouts', () => {
    expect(repoName('git@github.com:shanep/edutools.git')).toBe('edutools');
    expect(repoName('https://github.com/shanep/edutools')).toBe('edutools');
    expect(repoName('/srv/git/tools.git')).toBe('tools');
    expect(repoName('/srv/git/tools/')).toBe('tools');
    expect(repoName('')).toBe('repo');
    expect(
      checkoutOf({ repoUrl: 'git@h:a/b.git', path: 'x', target: '~/.claude/skills/x' }, '/h'),
    ).toBe(path.join('/h', 'repos', 'b'));
    expect(
      checkoutOf(
        { repoUrl: 'git@h:a/b.git', path: 'x', target: '~/.claude/x', checkout: '~/src/b' },
        '/h',
      ),
    ).toBe(path.join('/h', 'src', 'b'));
  });

  it('matches MCP configs with placeholders and CLI added keys', () => {
    const template = { command: 'npx', args: ['-y', 'gh'], env: { TOKEN: '${secret:GH}' }, n: 1 };
    const live = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'gh'],
      env: { TOKEN: 'real' },
      n: 1,
    };
    expect(matchesTemplate(template, live)).toBe(true);
    expect(matchesTemplate(template, { ...live, env: { TOKEN: 5 } })).toBe(false);
    expect(matchesTemplate(template, { ...live, command: 'node' })).toBe(false);
    expect(matchesTemplate(template, { ...live, args: ['-y'] })).toBe(false);
    expect(matchesTemplate(template, { ...live, args: ['-y', 'other'] })).toBe(false);
    expect(matchesTemplate(template, { ...live, args: 'x' })).toBe(false);
    expect(matchesTemplate(template, { ...live, n: 2 })).toBe(false);
    expect(matchesTemplate(template, ['x'])).toBe(false);
    expect(matchesTemplate(null, null)).toBe(true);
  });
});

interface World {
  readonly home: string;
  readonly repo: string;
  readonly manifest: Manifest;
}

async function world(): Promise<World> {
  const home = await scratchDir();
  const repo = await scratchDir();
  await writeTree(repo, {
    'global/CLAUDE.md': 'shared',
    'global/settings.json': '{"model":"opus","env":{"A":"1"}}',
    'machines/box.json': '{"env":{"B":"2"}}',
    'skills/voice/SKILL.md': 'v',
    'agents/a.md': 'a',
  });
  const manifest: Manifest = {
    ...emptyManifest(),
    items: [
      {
        id: 'agent:a',
        kind: 'agent',
        source: 'agents/a.md',
        target: '~/.claude/agents/a.md',
        mode: 'copy',
      },
      {
        id: 'claude-md',
        kind: 'claude-md',
        source: 'global/CLAUDE.md',
        target: '~/.claude/CLAUDE.md',
        mode: 'link',
      },
      {
        id: 'gone',
        kind: 'skill',
        source: 'skills/gone',
        target: '~/.claude/skills/gone',
        mode: 'link',
      },
      {
        id: 'odd',
        kind: 'agent',
        source: 'agents/a.md',
        target: '~/.claude/agents/odd.md',
        mode: 'generate',
      },
      {
        id: 'settings',
        kind: 'settings',
        source: 'global/settings.json',
        target: '~/.claude/settings.json',
        mode: 'generate',
      },
      {
        id: 'skill:voice',
        kind: 'skill',
        source: 'skills/voice',
        target: '~/.claude/skills/voice',
        mode: 'link',
      },
    ],
  };
  return { home, repo, manifest };
}

describe('planApply', () => {
  it('plans links, copies, generated settings and notes on a fresh machine', async () => {
    const { home, repo, manifest } = await world();
    await writeTree(home, { '.claude/CLAUDE.md': 'old local file' });
    const actions = await planApply(manifest, repo, fakePaths(home), 'box');
    const claude = path.join(home, '.claude');
    expect(actions).toStrictEqual([
      { kind: 'mkdir', path: path.join(claude, 'agents') },
      {
        kind: 'copy',
        source: path.join(repo, 'agents', 'a.md'),
        target: path.join(claude, 'agents', 'a.md'),
      },
      { kind: 'backup', path: path.join(claude, 'CLAUDE.md') },
      {
        kind: 'link',
        source: path.join(repo, 'global', 'CLAUDE.md'),
        target: path.join(claude, 'CLAUDE.md'),
      },
      { kind: 'note', message: 'gone: skills/gone is missing from the config repo' },
      { kind: 'note', message: 'odd: generate mode only works for settings' },
      {
        kind: 'generate-settings',
        target: path.join(claude, 'settings.json'),
        content: stableJson({ model: 'opus', env: { A: '1', B: '2' } }),
      },
      { kind: 'mkdir', path: path.join(claude, 'skills') },
      {
        kind: 'link',
        source: path.join(repo, 'skills', 'voice'),
        target: path.join(claude, 'skills', 'voice'),
      },
    ]);
  });

  it('plans nothing for items already in place, and replaces a linked settings file', async () => {
    const { home, repo, manifest } = await world();
    const claude = path.join(home, '.claude');
    await mkdir(path.join(claude, 'skills'), { recursive: true });
    await writeTree(home, {
      '.claude/agents/a.md': 'a',
      '.claude/settings.json': '{"env":{"B":"2","A":"1"},"model":"opus"}',
      'dotfiles/settings.json': '{"model":"opus","env":{"A":"1","B":"2"}}',
    });
    await symlink(path.join(repo, 'global', 'CLAUDE.md'), path.join(claude, 'CLAUDE.md'));
    await symlink(path.join(repo, 'skills', 'voice'), path.join(claude, 'skills', 'voice'));
    const notes = [
      { kind: 'note', message: 'gone: skills/gone is missing from the config repo' },
      { kind: 'note', message: 'odd: generate mode only works for settings' },
    ];
    expect(await planApply(manifest, repo, fakePaths(home), 'box')).toStrictEqual(notes);
    const settings = path.join(claude, 'settings.json');
    await rm(settings);
    await symlink(path.join(home, 'dotfiles', 'settings.json'), settings);
    const actions = await planApply(manifest, repo, fakePaths(home), 'box');
    expect(
      actions.filter((action) => action.kind !== 'note').map((action) => action.kind),
    ).toStrictEqual(['backup', 'generate-settings']);
  });

  it('clones external repos once and links into them', async () => {
    const home = await scratchDir();
    const remote = await bareRemoteWith(exec, {
      'skills/canvas/SKILL.md': 'c',
      'skills/quiz/SKILL.md': 'q',
    });
    const manifest: Manifest = {
      ...emptyManifest(),
      external: [
        {
          repoUrl: remote,
          path: 'skills/canvas',
          target: '~/.claude/skills/canvas',
          checkout: '~/repos/edutools',
        },
        {
          repoUrl: remote,
          path: 'skills/quiz',
          target: '~/.claude/skills/quiz',
          checkout: '~/repos/edutools',
        },
      ],
    };
    const repo = await scratchDir();
    const checkout = path.join(home, 'repos', 'edutools');
    expect(await planApply(manifest, repo, fakePaths(home), 'box')).toStrictEqual([
      { kind: 'clone-external', repoUrl: remote, destination: checkout },
      { kind: 'mkdir', path: path.join(home, '.claude', 'skills') },
      {
        kind: 'link',
        source: path.join(checkout, 'skills', 'canvas'),
        target: path.join(home, '.claude', 'skills', 'canvas'),
      },
      {
        kind: 'link',
        source: path.join(checkout, 'skills', 'quiz'),
        target: path.join(home, '.claude', 'skills', 'quiz'),
      },
    ]);
    await mkdir(checkout, { recursive: true });
    const again = await planApply(manifest, repo, fakePaths(home), 'box');
    expect(again.map((action) => action.kind)).toStrictEqual(['mkdir', 'link', 'link']);
  });

  it('adds missing marketplaces and plugins through the claude CLI', async () => {
    const home = await scratchDir();
    await writeTree(home, {
      '.claude/plugins/known_marketplaces.json': '{"official":{}}',
      '.claude/plugins/installed_plugins.json': '{"plugins":{"have@official":[]}}',
    });
    const manifest: Manifest = {
      ...emptyManifest(),
      plugins: {
        marketplaces: [
          { name: 'official', source: 'anthropics/claude-plugins-official' },
          { name: 'toString', source: 'me/market' },
        ],
        enabled: ['have@official', 'need@official'],
      },
    };
    expect(await planApply(manifest, await scratchDir(), fakePaths(home), 'box')).toStrictEqual([
      {
        kind: 'run-command',
        command: 'claude',
        args: ['plugin', 'marketplace', 'add', 'me/market'],
        description: 'add marketplace toString',
      },
      {
        kind: 'run-command',
        command: 'claude',
        args: ['plugin', 'install', 'need@official', '--scope', 'user'],
        description: 'install plugin need@official',
      },
    ]);
    const bare = await scratchDir();
    const all = await planApply(manifest, await scratchDir(), fakePaths(bare), 'box');
    expect(all).toHaveLength(4);
  });

  it('adds, replaces and skips MCP servers, backing up ~/.claude.json first', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    const same = { command: 'npx', env: { TOKEN: '${secret:T}' } };
    await writeTree(repo, {
      'mcp.json': JSON.stringify({
        mcpServers: { changed: { command: 'new' }, fresh: { url: 'https://f' }, same },
      }),
    });
    await writeTree(home, {
      '.claude.json': JSON.stringify({
        mcpServers: {
          changed: { command: 'old' },
          same: { type: 'stdio', command: 'npx', env: { TOKEN: 'x' } },
        },
      }),
    });
    const manifest: Manifest = { ...emptyManifest(), mcp: 'mcp.json' };
    const paths = fakePaths(home);
    expect(await planApply(manifest, repo, paths, 'box')).toStrictEqual([
      { kind: 'backup', path: paths.claudeJson },
      {
        kind: 'run-command',
        command: 'claude',
        args: ['mcp', 'remove', '--scope', 'user', 'changed'],
        description: 'replace MCP server changed',
      },
      {
        kind: 'run-command',
        command: 'claude',
        args: ['mcp', 'add-json', '--scope', 'user', 'changed', '{"command":"new"}'],
        description: 'add MCP server changed',
      },
      {
        kind: 'run-command',
        command: 'claude',
        args: ['mcp', 'add-json', '--scope', 'user', 'fresh', '{"url":"https://f"}'],
        description: 'add MCP server fresh',
      },
    ]);
    await writeTree(repo, { 'mcp.json': JSON.stringify({ mcpServers: { same } }) });
    expect(await planApply(manifest, repo, paths, 'box')).toStrictEqual([]);
  });
});
