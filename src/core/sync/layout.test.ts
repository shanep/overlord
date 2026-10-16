import path from 'node:path';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  collapseHome,
  expandHome,
  LAYOUT,
  machineSettingsPath,
  memoryPath,
  remoteSlug,
  repoFile,
  sanitizeHost,
} from './layout.js';

describe('LAYOUT', () => {
  it('matches the plan', () => {
    expect(LAYOUT).toStrictEqual({
      manifest: 'overlord.json',
      globalClaudeMd: 'global/CLAUDE.md',
      globalSettings: 'global/settings.json',
      globalRules: 'global/rules',
      skills: 'skills',
      agents: 'agents',
      commands: 'commands',
      outputStyles: 'output-styles',
      hooks: 'hooks',
      mcp: 'mcp.json',
      plugins: 'plugins.json',
      external: 'external.json',
      machines: 'machines',
      memory: 'memory',
    });
  });
});

describe('host and memory paths', () => {
  it('cleans host names', () => {
    expect(sanitizeHost(' Shanes-MacBook-Pro.local ')).toBe('shanes-macbook-pro');
    expect(sanitizeHost('box_1/evil')).toBe('box-1-evil');
    expect(sanitizeHost('..hidden')).toBe('hidden');
    expect(sanitizeHost('a.local.lan')).toBe('a.local.lan');
    expect(sanitizeHost('')).toBe('unknown-host');
    expect(machineSettingsPath('Box.local')).toBe('machines/box.json');
    expect(memoryPath('github.com/a/b')).toBe('memory/github.com/a/b');
  });

  it('builds repo paths with the platform separator', () => {
    expect(repoFile('/repo', 'global/settings.json')).toBe(
      path.join('/repo', 'global', 'settings.json'),
    );
  });
});

describe('home paths', () => {
  it('expands and collapses ~', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/.claude/x', '/h')).toBe(path.join('/h', '.claude', 'x'));
    expect(expandHome('/abs', '/h')).toBe('/abs');
    expect(expandHome('~other', '/h')).toBe('~other');
    expect(collapseHome('/h', '/h')).toBe('~');
    expect(collapseHome('/h/.claude/x', '/h')).toBe('~/.claude/x');
    expect(collapseHome('/other/x', '/h')).toBe('/other/x');
    expect(collapseHome('/h2/x', '/h')).toBe('/h2/x');
  });
});

describe('remoteSlug', () => {
  it('normalizes ssh, scp and https forms', () => {
    expect(remoteSlug('git@github.com:a/b.git')).toBe('github.com/a/b');
    expect(remoteSlug('https://github.com/a/b')).toBe('github.com/a/b');
    expect(remoteSlug('https://github.com/a/b.git/')).toBe('github.com/a/b');
    expect(remoteSlug('ssh://git@github.com:22/a/b.git')).toBe('github.com/a/b');
    expect(remoteSlug('https://user:pw@GitHub.com/Shanep/Repo')).toBe('github.com/shanep/repo');
    expect(remoteSlug('github.com:a/b')).toBe('github.com/a/b');
    expect(remoteSlug('  git@gitlab.com:group/sub/proj.git\n')).toBe('gitlab.com/group/sub/proj');
    expect(remoteSlug('https://host//a//b')).toBe('host/a/b');
  });

  it('rejects local paths and unsafe names', () => {
    expect(remoteSlug('/srv/git/repo.git')).toBeNull();
    expect(remoteSlug('file:///srv/repo')).toBeNull();
    expect(remoteSlug('./a:b')).toBeNull();
    expect(remoteSlug(':a/b')).toBeNull();
    expect(remoteSlug('https://host')).toBeNull();
    expect(remoteSlug('https://host/')).toBeNull();
    expect(remoteSlug('git@host:../etc')).toBeNull();
    expect(remoteSlug('git@host:a/./b')).toBeNull();
    expect(remoteSlug('git@host:a b/c')).toBeNull();
    expect(remoteSlug('https://ho st/a')).toBeNull();
    expect(remoteSlug('')).toBeNull();
  });

  const segment = fc
    .stringMatching(/^[a-z\d][\w.-]{0,12}$/u)
    .filter((value) => !value.endsWith('.git') && !value.endsWith('.'));

  it('gives every form of one remote the same slug', () => {
    fc.assert(
      fc.property(fc.domain(), segment, segment, (host, owner, repo) => {
        const expected = `${host}/${owner}/${repo}`.toLowerCase();
        expect(remoteSlug(`git@${host}:${owner}/${repo}.git`)).toBe(expected);
        expect(remoteSlug(`https://${host}/${owner}/${repo}`)).toBe(expected);
        expect(remoteSlug(`https://${host}/${owner}/${repo}.git/`)).toBe(expected);
        expect(remoteSlug(`ssh://git@${host}:2222/${owner}/${repo}.git`)).toBe(expected);
      }),
    );
  });

  it('never returns a slug that could climb out of the memory folder', () => {
    fc.assert(
      fc.property(fc.string(), (url) => {
        const parts = remoteSlug(url)?.split('/') ?? [];
        const safe = parts.every(
          (part) => /^[\w.-]+$/u.test(part) && part !== '.' && part !== '..',
        );
        expect(safe).toBe(true);
      }),
    );
  });
});
