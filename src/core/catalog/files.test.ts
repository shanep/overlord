import { describe, expect, it } from 'vitest';

import { agentFile, FakeGitHub, skillFile } from '../app/test-helpers/fake-github.js';

import { installFiles, MAX_FILES, relativeInside } from './files.js';
import { GitHubReader } from './github.js';
import type { FoundEntry } from './list.js';

function reader(github: FakeGitHub): GitHubReader {
  return new GitHubReader({
    fetch: github.fetch,
    token: async (): Promise<string | null> => {
      await Promise.resolve();
      return null;
    },
  });
}

function found(repo: string, path: string | null, skillId: string | null = null): FoundEntry {
  return {
    entry: { id: 'x', name: 'x', description: '', repo, group: '', installs: null, url: '' },
    path,
    skillId,
  };
}

const REPO = {
  'skills/pdf/SKILL.md': skillFile('pdf', 'PDFs'),
  'skills/pdf/scripts/fill.py': 'print(1)',
  'skills/pdf-extra/SKILL.md': skillFile('pdf-extra', 'More'),
  'nested/deep/odd-folder/SKILL.md': skillFile('renamed', 'Named in frontmatter'),
  'agents/helper.md': agentFile('helper', 'Helps'),
};

describe('relativeInside', () => {
  it('keeps paths inside the folder and refuses the rest', () => {
    expect(relativeInside('skills/pdf', 'skills/pdf/scripts/a.py')).toBe('scripts/a.py');
    expect(relativeInside('skills/pdf', 'skills/pdf-extra/SKILL.md')).toBeNull();
    expect(relativeInside('skills/pdf', 'skills/pdf')).toBeNull();
  });
});

describe('installFiles', () => {
  it('copies a skill folder and not its neighbor with a longer name', async () => {
    const plan = await installFiles(
      reader(new FakeGitHub({ 'o/r': REPO })),
      'skill',
      found('o/r', 'skills/pdf/SKILL.md'),
    );
    expect(plan.entryPath).toBe('skills/pdf/SKILL.md');
    expect(plan.files.map((file) => file.path)).toStrictEqual([
      'skills/pdf/SKILL.md',
      'skills/pdf/scripts/fill.py',
    ]);
  });

  it('copies one file for an agent', async () => {
    const plan = await installFiles(
      reader(new FakeGitHub({ 'o/r': REPO })),
      'agent',
      found('o/r', 'agents/helper.md'),
    );
    expect(plan.files.map((file) => file.path)).toStrictEqual(['agents/helper.md']);
  });

  it('finds a skills.sh skill by folder, then by frontmatter name', async () => {
    const read = reader(new FakeGitHub({ 'o/r': REPO }));
    const byFolder = await installFiles(read, 'skill', found('o/r', null, 'pdf-extra'));
    expect(byFolder.entryPath).toBe('skills/pdf-extra/SKILL.md');
    const byName = await installFiles(read, 'skill', found('o/r', null, 'renamed'));
    expect(byName.entryPath).toBe('nested/deep/odd-folder/SKILL.md');
    await expect(installFiles(read, 'skill', found('o/r', null, 'nope'))).rejects.toThrow(
      'Could not find the nope skill in o/r.',
    );
  });

  it('says when the entry has gone from the repository', async () => {
    const read = reader(new FakeGitHub({ 'o/r': REPO }));
    await expect(installFiles(read, 'agent', found('o/r', 'agents/gone.md'))).rejects.toThrow(
      'agents/gone.md is no longer in o/r.',
    );
    await expect(installFiles(read, 'skill', found('o/r', 'skills/gone/SKILL.md'))).rejects.toThrow(
      'skills/gone/SKILL.md is no longer in o/r.',
    );
  });

  it('refuses a folder too big to be a skill', async () => {
    const files: Record<string, string> = { 'skills/big/SKILL.md': skillFile('big', 'Big') };
    for (let index = 0; index < MAX_FILES; index += 1) {
      files[`skills/big/data/${String(index)}.txt`] = 'x';
    }
    const read = reader(new FakeGitHub({ 'o/r': files }));
    await expect(installFiles(read, 'skill', found('o/r', 'skills/big/SKILL.md'))).rejects.toThrow(
      /has 201 files/u,
    );
  });
});
