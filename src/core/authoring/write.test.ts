import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AuthoringKind } from './schema.js';
import { targetPath, writeAuthored } from './write.js';
import type { AuthoringScope, TargetDirs, WriteRequest } from './write.js';

const DIRS: TargetDirs = {
  paths: { userAgentsDir: '/home/u/.claude/agents', userSkillsDir: '/home/u/.claude/skills' },
  projectDir: '/work/app',
  pluginDir: '/work/plugin',
};

describe('targetPath', () => {
  const cases: readonly (readonly [AuthoringKind, AuthoringScope, string])[] = [
    ['agent', 'user', '/home/u/.claude/agents/rev.md'],
    ['skill', 'user', '/home/u/.claude/skills/rev/SKILL.md'],
    ['agent', 'project', '/work/app/.claude/agents/rev.md'],
    ['skill', 'project', '/work/app/.claude/skills/rev/SKILL.md'],
    ['agent', 'plugin', '/work/plugin/agents/rev.md'],
    ['skill', 'plugin', '/work/plugin/skills/rev/SKILL.md'],
  ];

  it.each(cases)('puts a %s in %s scope at %s', (kind, scope, expected) => {
    expect(targetPath(kind, scope, 'rev', DIRS)).toBe(expected);
  });

  it('needs a project or plugin directory for those scopes', () => {
    const userOnly: TargetDirs = { paths: DIRS.paths };
    expect(() => targetPath('agent', 'project', 'a', userOnly)).toThrow(
      'Saving to project scope needs a project directory.',
    );
    expect(() => targetPath('skill', 'plugin', 'a', { ...userOnly, pluginDir: '' })).toThrow(
      'Saving to plugin scope needs a plugin directory.',
    );
  });

  it.each(['', '.', '..', 'a/b', String.raw`a\b`, 'a\0b'])('refuses the file name %j', (name) => {
    expect(() => targetPath('agent', 'user', name, DIRS)).toThrow(
      `"${name}" cannot be used as a file name.`,
    );
  });

  it('allows dots inside a name', () => {
    expect(targetPath('agent', 'user', 'a..b', DIRS)).toBe('/home/u/.claude/agents/a..b.md');
  });
});

describe('writeAuthored', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'overlord-authoring-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates directories and writes a new file', async () => {
    const result = await writeAuthored({
      kind: 'skill',
      scope: 'project',
      name: 'fix',
      text: 'hello\n',
      paths: DIRS.paths,
      projectDir: root,
    });
    const file = path.join(root, '.claude', 'skills', 'fix', 'SKILL.md');
    expect(result).toStrictEqual({ ok: true, path: file, replaced: false });
    await expect(readFile(file, 'utf8')).resolves.toBe('hello\n');
  });

  it('refuses to replace an existing file by default', async () => {
    const request: WriteRequest = {
      kind: 'agent',
      scope: 'plugin',
      name: 'rev',
      text: 'new\n',
      paths: DIRS.paths,
      pluginDir: root,
    };
    await writeAuthored({ ...request, text: 'old\n' });
    const file = path.join(root, 'agents', 'rev.md');
    await expect(writeAuthored(request)).resolves.toStrictEqual({
      ok: false,
      path: file,
      reason: 'exists',
    });
    await expect(writeAuthored({ ...request, overwrite: false })).resolves.toStrictEqual({
      ok: false,
      path: file,
      reason: 'exists',
    });
    await expect(readFile(file, 'utf8')).resolves.toBe('old\n');
  });

  it('replaces an existing file when asked', async () => {
    const file = path.join(root, 'agents', 'rev.md');
    await writeAuthored({
      kind: 'agent',
      scope: 'user',
      name: 'rev',
      text: 'old\n',
      paths: { userAgentsDir: path.join(root, 'agents'), userSkillsDir: root },
    });
    const result = await writeAuthored({
      kind: 'agent',
      scope: 'user',
      name: 'rev',
      text: 'new\n',
      paths: { userAgentsDir: path.join(root, 'agents'), userSkillsDir: root },
      overwrite: true,
    });
    expect(result).toStrictEqual({ ok: true, path: file, replaced: true });
    await expect(readFile(file, 'utf8')).resolves.toBe('new\n');
  });

  it('passes through errors other than an existing file', async () => {
    const locked = path.join(root, 'locked');
    await mkdir(path.join(locked, 'agents'), { recursive: true });
    await chmod(path.join(locked, 'agents'), 0o500);
    try {
      await expect(
        writeAuthored({
          kind: 'agent',
          scope: 'plugin',
          name: 'rev',
          text: 'x',
          paths: DIRS.paths,
          pluginDir: locked,
        }),
      ).rejects.toThrow(/EACCES|EPERM/u);
    } finally {
      await chmod(path.join(locked, 'agents'), 0o700);
    }
  });
});
