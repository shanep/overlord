import { lstat, readFile, readlink, symlink } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Action } from './actions.js';
import { applyPlan, type ApplyDeps, backupDirName, backupLocation } from './apply.js';
import type { Exec } from './exec.js';
import { pathExists } from './files.js';
import { emptyManifest, type Manifest } from './manifest.js';
import { planApply } from './plan.js';
import { createMemorySecretStore } from './secrets.js';
import {
  bareRemoteWith,
  type Call,
  fakeExec,
  fakePaths,
  isolatedExec,
  scratchDir,
  writeTree,
} from './test-helpers/fixtures.js';

const exec: Exec = isolatedExec();

const throwing: Exec = async () => {
  await Promise.resolve();
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- checks how a non-Error rejection is reported
  throw 'plain string';
};

const now = new Date('2026-10-15T17:44:00.123Z');
const stamp = 'overlord-2026-10-15T17-44-00-123Z';

function deps(home: string, overrides: Partial<ApplyDeps> = {}): ApplyDeps {
  return {
    exec,
    secrets: createMemorySecretStore(),
    paths: fakePaths(home),
    now: () => now,
    platform: 'linux',
    ...overrides,
  };
}

describe('backup naming', () => {
  it('stamps folders and keeps paths relative to home', () => {
    expect(backupDirName(now)).toBe(stamp);
    expect(backupLocation('/b', '/h/.claude/x', '/h')).toBe(path.join('/b', '.claude', 'x'));
    expect(backupLocation('/b', '/etc/x', '/h')).toBe(path.join('/b', '_root', 'etc', 'x'));
    expect(backupLocation('/b', '/h', '/h')).toBe(path.join('/b', '_root', 'h'));
  });
});

describe('applyPlan', () => {
  it('applies a plan, backs up first, and a second plan finds nothing to do', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    await writeTree(repo, {
      'global/CLAUDE.md': 'shared',
      'global/settings.json': '{"model":"opus"}',
      'machines/box.json': '{"env":{"B":"2"}}',
      'skills/voice/SKILL.md': 'v',
      'agents/a.md': 'a',
    });
    await writeTree(home, {
      '.claude/CLAUDE.md': 'old local',
      'dotfiles/settings.json': '{"old":true}',
    });
    await symlink(
      path.join(home, 'dotfiles', 'settings.json'),
      path.join(home, '.claude', 'settings.json'),
    );
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
    const paths = fakePaths(home);
    const actions = await planApply(manifest, repo, paths, 'box');
    const result = await applyPlan(actions, deps(home));
    const backup = path.join(home, '.claude', 'backups', stamp);
    expect(result).toStrictEqual({ backupDir: backup, performed: actions, failed: null });

    const claude = path.join(home, '.claude');
    expect(await readlink(path.join(claude, 'CLAUDE.md'))).toBe(
      path.join(repo, 'global', 'CLAUDE.md'),
    );
    expect(await readlink(path.join(claude, 'skills', 'voice'))).toBe(
      path.join(repo, 'skills', 'voice'),
    );
    expect(await readFile(path.join(claude, 'agents', 'a.md'), 'utf8')).toBe('a');
    const settingsInfo = await lstat(path.join(claude, 'settings.json'));
    expect(settingsInfo.isFile()).toBe(true);
    expect(JSON.parse(await readFile(path.join(claude, 'settings.json'), 'utf8'))).toStrictEqual({
      model: 'opus',
      env: { B: '2' },
    });
    // The old files are in the backup, and the linked dot-files settings were not written through.
    expect(await readFile(path.join(backup, '.claude', 'CLAUDE.md'), 'utf8')).toBe('old local');
    expect(await readlink(path.join(backup, '.claude', 'settings.json'))).toBe(
      path.join(home, 'dotfiles', 'settings.json'),
    );
    expect(await readFile(path.join(home, 'dotfiles', 'settings.json'), 'utf8')).toBe(
      '{"old":true}',
    );

    const again = await planApply(manifest, repo, paths, 'box');
    expect(again).toStrictEqual([]);
    expect(await applyPlan(again, deps(home))).toStrictEqual({
      backupDir: null,
      performed: [],
      failed: null,
    });
  });

  it('refuses to replace a file that was not backed up', async () => {
    const home = await scratchDir();
    await writeTree(home, { 'a.md': 'keep me' });
    const target = path.join(home, 'a.md');
    const actions: Action[] = [
      { kind: 'mkdir', path: path.join(home, 'made') },
      { kind: 'write-file', target, content: 'new' },
      { kind: 'mkdir', path: path.join(home, 'never') },
    ];
    const result = await applyPlan(actions, deps(home));
    expect(result).toStrictEqual({
      backupDir: null,
      performed: [actions[0]],
      failed: {
        action: actions[1],
        message: `Refusing to replace ${target}: it was not backed up first`,
      },
    });
    expect(await readFile(target, 'utf8')).toBe('keep me');
    expect(await pathExists(path.join(home, 'made'))).toBe(true);
    expect(await pathExists(path.join(home, 'never'))).toBe(false);
  });

  it('replaces a symlink without a backup, since the data it points at stays', async () => {
    const home = await scratchDir();
    await writeTree(home, { 'data.md': 'd', 'new.md': 'n' });
    await symlink(path.join(home, 'data.md'), path.join(home, 'link'));
    const result = await applyPlan(
      [{ kind: 'link', source: path.join(home, 'new.md'), target: path.join(home, 'link') }],
      deps(home),
    );
    expect(result.failed).toBeNull();
    expect(await readlink(path.join(home, 'link'))).toBe(path.join(home, 'new.md'));
    expect(await readFile(path.join(home, 'data.md'), 'utf8')).toBe('d');
  });

  it('removes only what it backed up', async () => {
    const home = await scratchDir();
    await writeTree(home, { 'old/a.md': 'a', 'b.md': 'b' });
    const old = path.join(home, 'old');
    const result = await applyPlan(
      [
        { kind: 'backup', path: old },
        { kind: 'backup', path: old },
        { kind: 'backup', path: path.join(home, 'missing') },
        { kind: 'remove', path: old },
        { kind: 'remove', path: path.join(home, 'b.md') },
      ],
      deps(home),
    );
    expect(result.failed?.message).toBe(
      `Refusing to replace ${path.join(home, 'b.md')}: it was not backed up first`,
    );
    expect(result.performed.map((action) => action.kind)).toStrictEqual([
      'backup',
      'backup',
      'backup',
      'remove',
    ]);
    expect(await pathExists(old)).toBe(false);
    expect(
      await readFile(path.join(home, '.claude', 'backups', stamp, 'old', 'a.md'), 'utf8'),
    ).toBe('a');
    expect(await readFile(path.join(home, 'b.md'), 'utf8')).toBe('b');
  });

  it('stops before doing anything when a backup fails', async () => {
    const home = await scratchDir();
    await writeTree(home, { 'a.md': 'a', '.claude/backups': 'a file where the folder should be' });
    const target = path.join(home, 'a.md');
    const actions: Action[] = [
      { kind: 'backup', path: target },
      { kind: 'write-file', target, content: 'new' },
    ];
    const result = await applyPlan(actions, deps(home));
    expect(result.backupDir).toBe(path.join(home, '.claude', 'backups', stamp));
    expect(result.performed).toStrictEqual([]);
    expect(result.failed?.action).toStrictEqual({ kind: 'backup', path: target });
    expect(result.failed?.message).toMatch(/E(?:NOTDIR|EXIST)/u);
    expect(await readFile(target, 'utf8')).toBe('a');
  });

  it('fills secrets into commands and reports failures', async () => {
    const home = await scratchDir();
    const fake = fakeExec((call: Call) => ({
      code: call.args.includes('fail') ? 1 : 0,
      stdout: '',
      stderr: ' boom \n',
    }));
    const secrets = createMemorySecretStore({ GH: 'real-token' });
    const add: Action = {
      kind: 'run-command',
      command: 'claude',
      args: ['mcp', 'add-json', 'gh', '{"env":{"T":"${secret:GH}"}}'],
      description: 'add',
    };
    const ok = await applyPlan([add], deps(home, { exec: fake.exec, secrets }));
    expect(ok.failed).toBeNull();
    expect(fake.calls).toStrictEqual([
      {
        command: 'claude',
        args: ['mcp', 'add-json', 'gh', '{"env":{"T":"real-token"}}'],
        options: { timeoutMs: 300_000 },
      },
    ]);
    const failing: Action = {
      kind: 'run-command',
      command: 'claude',
      args: ['fail'],
      description: 'f',
    };
    const failed = await applyPlan([failing], deps(home, { exec: fake.exec, secrets }));
    expect(failed.failed).toStrictEqual({ action: failing, message: 'claude exited 1: boom' });
    const missing: Action = {
      kind: 'run-command',
      command: 'claude',
      args: ['${secret:A}', 'x ${secret:B}'],
      description: 'm',
    };
    const result = await applyPlan([missing], deps(home, { exec: fake.exec, secrets }));
    expect(result.failed).toStrictEqual({ action: missing, message: 'Missing secrets: A, B' });
    expect(fake.calls).toHaveLength(2);
  });

  it('reports a rejection that is not an Error', async () => {
    const home = await scratchDir();
    const action: Action = { kind: 'run-command', command: 'x', args: [], description: 'x' };
    const result = await applyPlan([action], deps(home, { exec: throwing }));
    expect(result.failed).toStrictEqual({ action, message: 'plain string' });
  });

  it('clones external repos once', async () => {
    const home = await scratchDir();
    const remote = await bareRemoteWith(exec, { 'skills/canvas/SKILL.md': 'c' });
    const destination = path.join(home, 'repos', 'edutools');
    const clone: Action = { kind: 'clone-external', repoUrl: remote, destination };
    const first = await applyPlan([clone], deps(home));
    expect(first.failed).toBeNull();
    expect(await readFile(path.join(destination, 'skills', 'canvas', 'SKILL.md'), 'utf8')).toBe(
      'c',
    );
    const fake = fakeExec(() => ({ code: 0, stdout: '', stderr: '' }));
    const second = await applyPlan([clone], deps(home, { exec: fake.exec }));
    expect(second.failed).toBeNull();
    expect(fake.calls).toStrictEqual([]);
  });

  it('copies instead of linking on Windows, and skips notes', async () => {
    const home = await scratchDir();
    await writeTree(home, { 'src/a.md': 'a' });
    const link: Action = {
      kind: 'link',
      source: path.join(home, 'src'),
      target: path.join(home, 'out', 'dst'),
    };
    const note: Action = { kind: 'note', message: 'n' };
    const result = await applyPlan([note, link], deps(home, { platform: 'win32' }));
    expect(result).toStrictEqual({ backupDir: null, performed: [link], failed: null });
    const copied = await lstat(path.join(home, 'out', 'dst'));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(home, 'out', 'dst', 'a.md'), 'utf8')).toBe('a');
  });
});
