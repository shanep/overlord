import { symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Exec } from './exec.js';
import { createStatusResolver } from './repo-status.js';
import {
  fakeExec,
  git,
  isolatedExec,
  repoWith,
  scratchDir,
  writeTree,
} from './test-helpers/fixtures.js';

const exec: Exec = isolatedExec();

describe('createStatusResolver', () => {
  it('badges files in the config repo as versioned or modified', async () => {
    const config = await repoWith(exec, { 'global/CLAUDE.md': 'a', 'global/settings.json': '{}' });
    await git(exec, config, ['remote', 'add', 'origin', 'git@github.com:me/claude-config.git']);
    const resolver = await createStatusResolver(exec, config);
    expect(resolver.configRoot).toBe(config);
    const home = await scratchDir();
    await symlink(path.join(config, 'global', 'CLAUDE.md'), path.join(home, 'CLAUDE.md'));
    expect(await resolver.resolve(path.join(home, 'CLAUDE.md'))).toStrictEqual({
      status: 'versioned',
      realPath: path.join(config, 'global', 'CLAUDE.md'),
      repo: { root: config, remote: 'git@github.com:me/claude-config.git', dirty: false },
    });
    await writeFile(path.join(config, 'global', 'settings.json'), '{"a":1}');
    expect(await resolver.resolve(path.join(config, 'global', 'settings.json'))).toStrictEqual({
      status: 'modified',
      realPath: null,
      repo: { root: config, remote: 'git@github.com:me/claude-config.git', dirty: true },
    });
  });

  it('badges links into other repos as external, and ignored or plain files as local only', async () => {
    const other = await repoWith(exec, {
      '.gitignore': 'secret.md\n',
      'skills/canvas/SKILL.md': 's',
    });
    await writeTree(other, { 'secret.md': 'x' });
    const home = await scratchDir();
    await writeTree(home, { 'plain.md': 'p' });
    await symlink(path.join(other, 'skills', 'canvas'), path.join(home, 'canvas'));
    const resolver = await createStatusResolver(exec, null);
    expect(resolver.configRoot).toBeNull();
    expect(await resolver.resolve(path.join(home, 'canvas'))).toStrictEqual({
      status: 'external-repo',
      realPath: path.join(other, 'skills', 'canvas'),
      repo: { root: other, remote: null, dirty: false },
    });
    expect(await resolver.resolve(path.join(other, 'secret.md'))).toStrictEqual({
      status: 'local-only',
      realPath: null,
      repo: null,
    });
    expect(await resolver.resolve(path.join(home, 'plain.md'))).toStrictEqual({
      status: 'local-only',
      realPath: null,
      repo: null,
    });
  });

  it('asks git for each remote once', async () => {
    const fake = fakeExec((call) => {
      if (call.args.includes('rev-parse')) {
        return { code: 0, stdout: '/elsewhere\n', stderr: '' };
      }
      if (call.args.includes('get-url')) {
        return { code: 0, stdout: 'git@h:a/b\n', stderr: '' };
      }
      return { code: call.args.includes('check-ignore') ? 1 : 0, stdout: '', stderr: '' };
    });
    const resolver = await createStatusResolver(fake.exec, null);
    const first = await resolver.resolve('/elsewhere/a');
    const second = await resolver.resolve('/elsewhere/b');
    expect(first.repo?.remote).toBe('git@h:a/b');
    expect(second.repo?.remote).toBe('git@h:a/b');
    expect(fake.calls.filter((call) => call.args.includes('get-url'))).toHaveLength(1);
  });
});
