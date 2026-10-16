import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { summarizePlan } from './actions.js';
import { bootstrapNewMachine } from './bootstrap.js';
import type { Exec } from './exec.js';
import { emptyManifest, serializeManifest, type Manifest } from './manifest.js';
import {
  bareRemoteWith,
  fakePaths,
  git,
  isolatedExec,
  repoWith,
  scratchDir,
  writeTree,
} from './test-helpers/fixtures.js';

const exec: Exec = isolatedExec();

async function configRemote(): Promise<{ remote: string; external: string; manifest: Manifest }> {
  const external = await bareRemoteWith(exec, { 'skills/canvas/SKILL.md': 'c' });
  const manifest: Manifest = {
    ...emptyManifest(),
    items: [
      {
        id: 'claude-md',
        kind: 'claude-md',
        source: 'global/CLAUDE.md',
        target: '~/.claude/CLAUDE.md',
        mode: 'link',
      },
    ],
    external: [
      {
        repoUrl: external,
        path: 'skills/canvas',
        target: '~/.claude/skills/canvas',
        checkout: '~/repos/edutools',
      },
    ],
  };
  const remote = await bareRemoteWith(exec, {
    'overlord.json': serializeManifest(manifest),
    'global/CLAUDE.md': 'shared',
  });
  return { remote, external, manifest };
}

describe('bootstrapNewMachine', () => {
  it('clones the repo and its externals and returns the plan without applying it', async () => {
    const { remote, manifest } = await configRemote();
    const home = await scratchDir();
    const paths = fakePaths(home);
    const destination = path.join(home, 'repos', 'claude-config');
    const result = await bootstrapNewMachine({
      repoUrl: remote,
      dest: destination,
      paths,
      host: 'box',
      deps: { exec },
    });
    const checkout = path.join(home, 'repos', 'edutools');
    const claude = path.join(home, '.claude');
    expect(result.cloned).toBe(true);
    expect(result.externalsCloned).toStrictEqual([checkout]);
    expect(result.manifest).toStrictEqual(manifest);
    expect(result.actions).toStrictEqual([
      { kind: 'mkdir', path: claude },
      {
        kind: 'link',
        source: path.join(destination, 'global', 'CLAUDE.md'),
        target: path.join(claude, 'CLAUDE.md'),
      },
      { kind: 'mkdir', path: path.join(claude, 'skills') },
      {
        kind: 'link',
        source: path.join(checkout, 'skills', 'canvas'),
        target: path.join(claude, 'skills', 'canvas'),
      },
    ]);
    expect(result.summary).toBe(summarizePlan(result.actions, home));
    expect(await readFile(path.join(destination, 'global', 'CLAUDE.md'), 'utf8')).toBe('shared');
    expect(await readFile(path.join(checkout, 'skills', 'canvas', 'SKILL.md'), 'utf8')).toBe('c');

    const again = await bootstrapNewMachine({
      repoUrl: remote,
      dest: destination,
      paths,
      host: 'box',
      deps: { exec },
    });
    expect(again.cloned).toBe(false);
    expect(again.externalsCloned).toStrictEqual([]);
  });

  it('clones into an existing empty folder', async () => {
    const { remote } = await configRemote();
    const home = await scratchDir();
    const destination = path.join(home, 'empty');
    await mkdir(destination);
    const result = await bootstrapNewMachine({
      repoUrl: remote,
      dest: destination,
      paths: fakePaths(home),
      host: 'b',
      deps: { exec },
    });
    expect(result.cloned).toBe(true);
  });

  it('accepts an existing clone whose remote is another form of the same URL', async () => {
    const destination = await repoWith(exec, {
      'overlord.json': serializeManifest(emptyManifest()),
    });
    await git(exec, destination, [
      'remote',
      'add',
      'origin',
      'git@github.com:me/claude-config.git',
    ]);
    const home = await scratchDir();
    const result = await bootstrapNewMachine({
      repoUrl: 'https://github.com/me/claude-config',
      dest: destination,
      paths: fakePaths(home),
      host: 'b',
      deps: { exec },
    });
    expect(result).toStrictEqual({
      manifest: emptyManifest(),
      actions: [],
      summary: 'Nothing to do. Everything already matches the config repo.\n',
      cloned: false,
      externalsCloned: [],
    });
  });

  it('refuses a folder that is not a clone of the repo', async () => {
    const home = await scratchDir();
    const paths = fakePaths(home);
    const plain = await scratchDir();
    await writeTree(plain, { 'x.txt': 'x' });
    const url = 'git@github.com:me/claude-config.git';
    await expect(
      bootstrapNewMachine({ repoUrl: url, dest: plain, paths, host: 'b', deps: { exec } }),
    ).rejects.toThrow(`${plain} already exists and is not a clone of ${url}`);
    const other = await repoWith(exec, { 'a.txt': 'a' });
    await git(exec, other, ['remote', 'add', 'origin', 'git@github.com:me/other.git']);
    await expect(
      bootstrapNewMachine({ repoUrl: url, dest: other, paths, host: 'b', deps: { exec } }),
    ).rejects.toThrow('is not a clone of');
    const inner = path.join(other, 'inner');
    await writeTree(inner, { 'a.txt': 'a' });
    await git(exec, other, ['remote', 'set-url', 'origin', url]);
    await expect(
      bootstrapNewMachine({ repoUrl: url, dest: inner, paths, host: 'b', deps: { exec } }),
    ).rejects.toThrow('is not a clone of');
    const local = await repoWith(exec, { 'a.txt': 'a' });
    await git(exec, local, ['remote', 'add', 'origin', '/srv/a.git']);
    await expect(
      bootstrapNewMachine({ repoUrl: '/srv/b.git', dest: local, paths, host: 'b', deps: { exec } }),
    ).rejects.toThrow('is not a clone of');
  });

  it('fails when the repo has no manifest', async () => {
    const remote = await bareRemoteWith(exec, { 'README.md': 'r' });
    const home = await scratchDir();
    const destination = path.join(home, 'cfg');
    await expect(
      bootstrapNewMachine({
        repoUrl: remote,
        dest: destination,
        paths: fakePaths(home),
        host: 'b',
        deps: { exec },
      }),
    ).rejects.toThrow(
      `The config repo has no usable manifest: overlord.json not found in ${destination}`,
    );
  });
});
