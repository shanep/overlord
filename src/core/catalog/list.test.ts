import { describe, expect, it } from 'vitest';

import { agentFile, FakeGitHub, skillFile } from '../app/test-helpers/fake-github.js';

import { GitHubReader } from './github.js';
import {
  fallbackName,
  listRepo,
  readFrontmatter,
  searchSkillsSh,
  shortDescription,
} from './list.js';
import { repoSources } from './sources.js';

function reader(github: FakeGitHub): GitHubReader {
  return new GitHubReader({
    fetch: github.fetch,
    token: async (): Promise<string | null> => {
      await Promise.resolve();
      return null;
    },
  });
}

function source(kind: 'skill' | 'agent', id: string): ReturnType<typeof repoSources>[number] {
  const found = repoSources(kind).find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no ${kind} source ${id}`);
  }
  return found;
}

async function odd(): Promise<Response> {
  await Promise.resolve();
  return Response.json({ results: [] });
}

describe('entry text', () => {
  it('flattens a description and cuts a long one at a word', () => {
    expect(shortDescription('  one\n  two  ')).toBe('one two');
    const long = `${'word '.repeat(80)}end`;
    const cut = shortDescription(long);
    expect(cut.endsWith('word…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(301);
    expect(shortDescription('x'.repeat(400))).toBe(`${'x'.repeat(300)}…`);
  });

  it('names an entry after its folder or file when the frontmatter does not', () => {
    expect(fallbackName('skills/pdf/SKILL.md')).toBe('pdf');
    expect(fallbackName('categories/01-core/api-designer.md')).toBe('api-designer');
  });

  it('reads the name and description, and nothing from a file without frontmatter', () => {
    expect(readFrontmatter(skillFile('pdf', 'PDF things'))).toStrictEqual({
      name: 'pdf',
      description: 'PDF things',
    });
    expect(readFrontmatter('---\nname: "  "\ndescription: 3\n---\n')).toStrictEqual({
      name: null,
      description: '',
    });
    expect(readFrontmatter('# no frontmatter')).toStrictEqual({ name: null, description: '' });
    expect(
      readFrontmatter(
        "---\nname: 'loops'\ndescription: Use it. Triggers on: 'loop', 'flywheel'\n---\n",
      ),
    ).toStrictEqual({ name: 'loops', description: "Use it. Triggers on: 'loop', 'flywheel'" });
    expect(readFrontmatter('---\nname: [broken\n---\n')).toStrictEqual({
      name: '[broken',
      description: '',
    });
  });
});

describe('listRepo', () => {
  it('lists skill folders with their frontmatter, sorted by group and name', async () => {
    const github = new FakeGitHub({
      'wshobson/agents': {
        'plugins/python/skills/zeta/SKILL.md': skillFile('zeta', 'Last'),
        'plugins/python/skills/alpha/SKILL.md': skillFile('alpha', 'First'),
        'plugins/python/skills/alpha/scripts/run.py': 'print(1)',
        'plugins/go/skills/broken/SKILL.md': 'no frontmatter',
        'plugins/go/agents/gopher.md': agentFile('gopher', 'Go'),
      },
    });
    const found = await listRepo(reader(github), source('skill', 'wshobson/agents'));
    expect(found.map((entry) => [entry.entry.group, entry.entry.name])).toStrictEqual([
      ['go', 'broken'],
      ['python', 'alpha'],
      ['python', 'zeta'],
    ]);
    expect(found[1]).toStrictEqual({
      entry: {
        id: 'wshobson/agents:plugins/python/skills/alpha/SKILL.md',
        name: 'alpha',
        description: 'First',
        repo: 'wshobson/agents',
        group: 'python',
        installs: null,
        url: 'https://github.com/wshobson/agents/tree/HEAD/plugins/python/skills/alpha',
      },
      path: 'plugins/python/skills/alpha/SKILL.md',
      skillId: null,
    });
  });

  it('links an agent to its file and keeps one whose file will not load', async () => {
    const github = new FakeGitHub({
      'VoltAgent/awesome-claude-code-subagents': {
        'categories/01-core-development/api-designer.md': agentFile('api-designer', 'APIs'),
        'categories/01-core-development/README.md': '# Core',
      },
    });
    const read = reader(github);
    const volt = source('agent', 'VoltAgent/awesome-claude-code-subagents');
    const [entry] = await listRepo(read, volt);
    expect(entry?.entry).toMatchObject({
      name: 'api-designer',
      group: 'core-development',
      url: 'https://github.com/VoltAgent/awesome-claude-code-subagents/blob/HEAD/categories/01-core-development/api-designer.md',
    });
    github.rawStatus = 500;
    const [failed] = await listRepo(read, volt);
    expect(failed?.entry).toMatchObject({ name: 'api-designer', description: '' });
  });
});

describe('searchSkillsSh', () => {
  it('turns hits into entries and drops sources that are not GitHub repositories', async () => {
    const github = new FakeGitHub({});
    github.hits = [
      {
        id: 'anthropics/skills/pdf',
        source: 'anthropics/skills',
        skillId: 'pdf',
        name: 'pdf',
        installs: 9,
      },
      { id: 'x/y/z', source: 'x/y', skillId: 'z', name: 'z' },
      { id: 'weird', source: 'not a repo', skillId: 'w', name: 'w' },
    ];
    const found = await searchSkillsSh(github.fetch, ' pdf ');
    expect(github.urls[0]).toBe('https://skills.sh/api/search?q=pdf&limit=50');
    expect(found.map((entry) => entry.entry)).toStrictEqual([
      {
        id: 'skills.sh:anthropics/skills/pdf',
        name: 'pdf',
        description: '',
        repo: 'anthropics/skills',
        group: '',
        installs: 9,
        url: 'https://skills.sh/anthropics/skills/pdf',
      },
      {
        id: 'skills.sh:x/y/z',
        name: 'z',
        description: '',
        repo: 'x/y',
        group: '',
        installs: null,
        url: 'https://skills.sh/x/y/z',
      },
    ]);
    expect(found[0]).toMatchObject({ path: null, skillId: 'pdf' });
  });

  it('says when skills.sh fails or answers in a shape it cannot read', async () => {
    const github = new FakeGitHub({});
    github.searchStatus = 429;
    await expect(searchSkillsSh(github.fetch, 'pdf')).rejects.toThrow('skills.sh answered 429.');
    await expect(searchSkillsSh(odd, 'pdf')).rejects.toThrow(/cannot read/u);
  });
});
