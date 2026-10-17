import { describe, expect, it } from 'vitest';

import { FakeGitHub } from '../app/test-helpers/fake-github.js';

import { GitHubReader, githubUrl, isRepo } from './github.js';

const REPO = { 'o/r': { 'skills/a b/SKILL.md': 'hello', 'x.bin': 'xyz' } };

function reader(github: FakeGitHub, token: string | null = null): GitHubReader {
  return new GitHubReader({
    fetch: github.fetch,
    token: async (): Promise<string | null> => {
      await Promise.resolve();
      return token;
    },
  });
}

describe('GitHubReader', () => {
  it('lists a repository once, with file sizes and no folders', async () => {
    const github = new FakeGitHub(REPO);
    const read = reader(github);
    const first = await read.files('o/r');
    await read.files('o/r');
    expect(first).toStrictEqual([
      { path: 'skills/a b/SKILL.md', size: 5 },
      { path: 'x.bin', size: 3 },
    ]);
    expect(github.treeCalls()).toBe(1);
    expect(github.auth).toStrictEqual([null]);
  });

  it('signs the listing with the editor GitHub token when there is one', async () => {
    const github = new FakeGitHub(REPO);
    await reader(github, 'tok').files('o/r');
    expect(github.auth).toStrictEqual(['Bearer tok']);
  });

  it('reads raw files as text and bytes, encoding the path', async () => {
    const github = new FakeGitHub(REPO);
    const read = reader(github);
    expect(await read.text('o/r', 'skills/a b/SKILL.md')).toBe('hello');
    expect([...(await read.bytes('o/r', 'x.bin'))]).toStrictEqual([120, 121, 122]);
    expect(github.urls[0]).toBe('https://raw.githubusercontent.com/o/r/HEAD/skills/a%20b/SKILL.md');
    await expect(read.text('o/r', 'gone.md')).rejects.toThrow(
      'GitHub answered 404 for gone.md in o/r.',
    );
  });

  it('says why a listing failed, and tries again next time', async () => {
    const github = new FakeGitHub(REPO);
    const read = reader(github);
    github.treeStatus = 403;
    await expect(read.files('o/r')).rejects.toThrow(/anonymous requests/u);
    await expect(reader(github, 'tok').files('o/r')).rejects.toThrow(/rate limiting this account/u);
    github.treeStatus = 500;
    await expect(read.files('o/r')).rejects.toThrow('GitHub answered 500 listing o/r.');
    github.treeStatus = null;
    await expect(read.files('o/missing')).rejects.toThrow(
      'GitHub has no public repository o/missing.',
    );
    github.truncated = true;
    await expect(read.files('o/r')).rejects.toThrow(
      'o/r is too large for GitHub to list in one go.',
    );
    github.truncated = false;
    expect(await read.files('o/r')).toHaveLength(2);
    await expect(read.files('../etc')).rejects.toThrow('../etc is not a GitHub repository name.');
  });

  it('refuses a file list it cannot read', async () => {
    const read = new GitHubReader({
      fetch: async (): Promise<Response> => {
        await Promise.resolve();
        return Response.json({ tree: 'nope' });
      },
      token: async (): Promise<string | null> => {
        await Promise.resolve();
        return null;
      },
    });
    await expect(read.files('o/r')).rejects.toThrow(/cannot read/u);
  });
});

describe('repository names and links', () => {
  it('accepts owner/repo only', () => {
    expect(isRepo('anthropics/skills')).toBe(true);
    expect(isRepo('a.b/c-d_e')).toBe(true);
    expect(isRepo('a/..')).toBe(false);
    expect(isRepo('a/b/c')).toBe(false);
    expect(isRepo('https://github.com/a/b')).toBe(false);
  });

  it('links a file or a folder', () => {
    expect(githubUrl('o/r', 'skills/pdf', true)).toBe(
      'https://github.com/o/r/tree/HEAD/skills/pdf',
    );
    expect(githubUrl('o/r', 'a b.md')).toBe('https://github.com/o/r/blob/HEAD/a%20b.md');
  });
});
