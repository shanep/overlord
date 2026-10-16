import { lstat, readFile, readlink, symlink } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Action } from './actions.js';
import { applyPlan } from './apply.js';
import { pathExists } from './files.js';
import { planImportFromDotfiles, pointerReadme } from './import-dotfiles.js';
import { stableJson } from './json.js';
import { readManifest, serializeManifest } from './manifest.js';
import { planApply } from './plan.js';
import { createMemorySecretStore } from './secrets.js';
import { fakeExec, fakePaths, scratchDir, writeTree } from './test-helpers/fixtures.js';

interface Setup {
  readonly home: string;
  readonly dotfiles: string;
  readonly repo: string;
}

async function setup(): Promise<Setup> {
  const home = await scratchDir();
  const repo = await scratchDir();
  const dotfiles = path.join(home, 'repos', 'dot-files', 'claude');
  await writeTree(dotfiles, {
    'CLAUDE.md': 'global rules',
    'settings.json': '{"model":"opus","env":{"A":"1"}}',
    'keybindings.json': '[]',
    'README.md': 'old readme',
    'extra.txt': 'unknown',
    'skills/writing-voice/SKILL.md': 'voice',
    'agents/a.md': 'same agent',
    'rules/r.md': 'dotfiles rule',
    'output-styles/terse.md': 't',
    'commands/c.md': 'c',
    'agents-not-a-folder': 'x',
  });
  await writeTree(repo, {
    'overlord.json': serializeManifest({
      version: 1,
      claudeCodeVersion: '2.1.301',
      items: [
        {
          id: 'agent:old',
          kind: 'agent',
          source: 'agents/old.md',
          target: '~/.claude/agents/old.md',
          mode: 'link',
        },
      ],
      external: [],
      plugins: { marketplaces: [], enabled: [] },
      mcp: null,
      memory: { enabled: true, keyBy: 'git-remote' },
    }),
    'agents/old.md': 'old',
    'agents/a.md': 'same agent',
    'global/rules/r.md': 'repo rule',
    'machines/box.json': '{"env":{"B":"2"}}',
  });
  const claude = path.join(home, '.claude');
  await writeTree(home, { '.claude/agents/.keep': '', 'elsewhere/canvas/SKILL.md': 'c' });
  await symlink(path.join(repo, 'agents', 'old.md'), path.join(claude, 'agents', 'old.md'));
  await symlink(path.join(dotfiles, 'CLAUDE.md'), path.join(claude, 'CLAUDE.md'));
  await symlink(path.join(dotfiles, 'settings.json'), path.join(claude, 'settings.json'));
  await symlink(path.join(dotfiles, 'extra.txt'), path.join(claude, 'stray.txt'));
  await writeTree(home, { '.claude/skills/.keep': '' });
  await symlink(
    path.join(dotfiles, 'skills', 'writing-voice'),
    path.join(claude, 'skills', 'writing-voice'),
  );
  await symlink(path.join(home, 'elsewhere', 'canvas'), path.join(claude, 'skills', 'canvas'));
  return { home, dotfiles, repo };
}

function kinds(actions: readonly Action[], kind: Action['kind']): readonly Action[] {
  return actions.filter((action) => action.kind === kind);
}

describe('pointerReadme', () => {
  it('says where the files went', () => {
    expect(pointerReadme('~/repos/claude-config')).toBe(
      '# claude\n\nThis folder moved to the claude-config repo (~/repos/claude-config).\nOverlord links ~/.claude to that repo now, so edit the files there.\n',
    );
  });
});

describe('planImportFromDotfiles', () => {
  it('plans the move, the relinks, the manifest and the pointer', async () => {
    const { home, dotfiles, repo } = await setup();
    const paths = fakePaths(home);
    const plan = await planImportFromDotfiles(dotfiles, repo, paths, 'box');
    expect(plan.skipped).toStrictEqual([
      {
        path: path.join(dotfiles, 'agents-not-a-folder'),
        reason: 'not a Claude config file Overlord knows how to move',
      },
      {
        path: path.join(dotfiles, 'extra.txt'),
        reason: 'not a Claude config file Overlord knows how to move',
      },
      {
        path: path.join(dotfiles, 'rules', 'r.md'),
        reason: 'global/rules/r.md already exists in the repo with different content',
      },
    ]);
    expect(plan.moved.map((entry) => path.relative(dotfiles, entry.from))).toStrictEqual([
      'CLAUDE.md',
      'agents/a.md',
      'commands/c.md',
      'keybindings.json',
      'output-styles/terse.md',
      'settings.json',
      'skills/writing-voice',
    ]);
    expect(plan.moved[0]?.to).toBe(path.join(repo, 'global', 'CLAUDE.md'));
    expect(
      plan.manifest.items.map((item) => `${item.id} ${item.source} ${item.target} ${item.mode}`),
    ).toStrictEqual([
      'agent:a agents/a.md ~/.claude/agents/a.md link',
      'agent:old agents/old.md ~/.claude/agents/old.md link',
      'claude-md global/CLAUDE.md ~/.claude/CLAUDE.md link',
      'command:c commands/c.md ~/.claude/commands/c.md link',
      'keybindings global/keybindings.json ~/.claude/keybindings.json link',
      'output-style:terse output-styles/terse.md ~/.claude/output-styles/terse.md link',
      'settings global/settings.json ~/.claude/settings.json generate',
      'skill:writing-voice skills/writing-voice ~/.claude/skills/writing-voice link',
    ]);
    expect(plan.manifest.claudeCodeVersion).toBe('2.1.301');

    const claude = path.join(home, '.claude');
    expect(
      kinds(plan.actions, 'copy').map((action) =>
        action.kind === 'copy' ? path.relative(repo, action.target) : '',
      ),
    ).toStrictEqual([
      'global/CLAUDE.md',
      'commands/c.md',
      'global/keybindings.json',
      'output-styles/terse.md',
      'global/settings.json',
      'skills/writing-voice',
    ]);
    expect(kinds(plan.actions, 'remove')).toHaveLength(7);
    expect(kinds(plan.actions, 'mkdir')).toStrictEqual([
      { kind: 'mkdir', path: path.join(repo, 'commands') },
      { kind: 'mkdir', path: path.join(repo, 'output-styles') },
      { kind: 'mkdir', path: path.join(repo, 'skills') },
      { kind: 'mkdir', path: path.join(home, '.claude', 'commands') },
      { kind: 'mkdir', path: path.join(home, '.claude', 'output-styles') },
    ]);
    expect(plan.actions).toContainEqual({
      kind: 'generate-settings',
      target: path.join(claude, 'settings.json'),
      content: stableJson({ model: 'opus', env: { A: '1', B: '2' } }),
    });
    expect(plan.actions).toContainEqual({
      kind: 'write-file',
      target: path.join(repo, 'overlord.json'),
      content: serializeManifest(plan.manifest),
    });
    expect(plan.actions).toContainEqual({
      kind: 'write-file',
      target: path.join(dotfiles, 'README.md'),
      content: pointerReadme(
        path.relative(home, repo).startsWith('..') ? repo : `~/${path.relative(home, repo)}`,
      ),
    });
    expect(plan.actions).toContainEqual({ kind: 'backup', path: path.join(dotfiles, 'README.md') });
    expect(plan.actions).toContainEqual({ kind: 'backup', path: path.join(repo, 'overlord.json') });
    expect(kinds(plan.actions, 'note')).toStrictEqual([
      { kind: 'note', message: `~/.claude/stray.txt still points into ~/repos/dot-files/claude` },
    ]);
  });

  it('applies cleanly, and the imported manifest then plans nothing', async () => {
    const { home, dotfiles, repo } = await setup();
    const paths = fakePaths(home);
    const plan = await planImportFromDotfiles(dotfiles, repo, paths, 'box');
    const fake = fakeExec(() => ({ code: 0, stdout: '', stderr: '' }));
    const result = await applyPlan(plan.actions, {
      exec: fake.exec,
      secrets: createMemorySecretStore(),
      paths,
      now: () => new Date('2026-10-15T00:00:00.000Z'),
      platform: 'linux',
    });
    expect(result.failed).toBeNull();
    const claude = path.join(home, '.claude');
    expect(await readlink(path.join(claude, 'CLAUDE.md'))).toBe(
      path.join(repo, 'global', 'CLAUDE.md'),
    );
    expect(await readlink(path.join(claude, 'skills', 'writing-voice'))).toBe(
      path.join(repo, 'skills', 'writing-voice'),
    );
    expect(await readFile(path.join(repo, 'skills', 'writing-voice', 'SKILL.md'), 'utf8')).toBe(
      'voice',
    );
    const settingsInfo = await lstat(path.join(claude, 'settings.json'));
    expect(settingsInfo.isFile()).toBe(true);
    expect(await pathExists(path.join(dotfiles, 'CLAUDE.md'))).toBe(false);
    expect(await pathExists(path.join(dotfiles, 'skills', 'writing-voice'))).toBe(false);
    expect(await readFile(path.join(dotfiles, 'rules', 'r.md'), 'utf8')).toBe('dotfiles rule');
    expect(await readFile(path.join(dotfiles, 'README.md'), 'utf8')).toContain('This folder moved');
    const backups = path.join(claude, 'backups', 'overlord-2026-10-15T00-00-00-000Z');
    expect(
      await readFile(path.join(backups, 'repos', 'dot-files', 'claude', 'CLAUDE.md'), 'utf8'),
    ).toBe('global rules');
    expect(
      await readFile(path.join(backups, 'repos', 'dot-files', 'claude', 'README.md'), 'utf8'),
    ).toBe('old readme');
    const manifest = await readManifest(repo);
    expect(manifest).toStrictEqual({ ok: true, manifest: plan.manifest });
    const next = await planApply(plan.manifest, repo, paths, 'box');
    expect(next).toStrictEqual([]);
    expect(fake.calls).toStrictEqual([]);
  });

  it('starts a manifest when the repo has none, and moves an identical file without copying', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    const dotfiles = path.join(home, 'dot', 'claude');
    await writeTree(dotfiles, { 'CLAUDE.md': 'x' });
    await writeTree(repo, { 'global/CLAUDE.md': 'x' });
    const plan = await planImportFromDotfiles(dotfiles, repo, fakePaths(home), 'box');
    expect(plan.manifest.items.map((item) => item.id)).toStrictEqual(['claude-md']);
    expect(plan.manifest.claudeCodeVersion).toBeNull();
    expect(plan.actions.filter((action) => action.kind === 'copy')).toStrictEqual([]);
    expect(plan.actions.slice(0, 2)).toStrictEqual([
      { kind: 'backup', path: path.join(dotfiles, 'CLAUDE.md') },
      { kind: 'remove', path: path.join(dotfiles, 'CLAUDE.md') },
    ]);
  });

  it('refuses when the Claude folder is outside home', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    const paths = { ...fakePaths(home), configDir: '/opt/claude' };
    const plan = await planImportFromDotfiles(path.join(home, 'd'), repo, paths, 'box');
    expect(plan.actions).toStrictEqual([
      {
        kind: 'note',
        message:
          '/opt/claude is outside the home folder, so it cannot be described in overlord.json',
      },
    ]);
    expect(plan.moved).toStrictEqual([]);
    expect(plan.manifest.items).toStrictEqual([]);
  });
});
