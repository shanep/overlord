import { describe, expect, it } from 'vitest';

import { agentFile, FakeGitHub } from '../app/test-helpers/fake-github.js';

import { GitHubReader } from './github.js';
import type { PickTopic } from './picks.js';
import { findPicks, installKey } from './picks.js';

const VOLT = 'VoltAgent/awesome-claude-code-subagents';
const ECC = 'affaan-m/ECC';
const SHOBSON = 'wshobson/agents';

const PYTHON: PickTopic = {
  label: 'Python',
  query: 'python',
  words: ['python', 'pytest'],
  reason: '90 .py file reads or edits in 3 sessions.',
};

const LATEX: PickTopic = {
  label: 'LaTeX',
  query: 'latex',
  words: ['latex', 'academic'],
  reason: '30 .tex file reads or edits in 3 sessions.',
};

function github(): FakeGitHub {
  const fake = new FakeGitHub({
    [VOLT]: {
      'categories/02-language-specialists/python-pro.md': agentFile('python-pro', 'Python expert'),
      'categories/02-language-specialists/rust-pro.md': agentFile('rust-pro', 'Rust expert'),
      'categories/02-language-specialists/README.md': '# Languages',
    },
    [ECC]: {
      'agents/python-reviewer.md': agentFile('python-reviewer', 'Reviews Python'),
      'agents/python-pro.md': agentFile('python-pro', 'Same name as the VoltAgent one'),
    },
    [SHOBSON]: {
      'plugins/python-development/agents/fastapi-pro.md': agentFile('fastapi-pro', 'FastAPI'),
      'plugins/academic-writing/agents/editor.md': agentFile('editor', 'Edits papers'),
    },
  });
  fake.hits = [
    {
      id: 'a/b/python-basics',
      source: 'a/b',
      skillId: 'python-basics',
      name: 'python-basics',
      installs: 10,
    },
    {
      id: 'c/d/pytest-pro',
      source: 'c/d',
      skillId: 'pytest-pro',
      name: 'pytest-pro',
      installs: 900,
    },
    { id: 'e/f/uv', source: 'e/f', skillId: 'uv', name: 'uv', installs: 50 },
  ];
  return fake;
}

function reader(fake: FakeGitHub): GitHubReader {
  return new GitHubReader({
    fetch: fake.fetch,
    token: async (): Promise<string | null> => {
      await Promise.resolve();
      return null;
    },
  });
}

describe('findPicks', () => {
  it('picks the most installed skills and the agents whose name fits, then whose group does', async () => {
    const fake = github();
    const result = await findPicks(
      { reader: reader(fake), fetch: fake.fetch },
      [PYTHON],
      new Set([installKey('agent', 'python-reviewer')]),
    );
    expect(result.errors).toStrictEqual([]);
    expect(result.picks.map(({ pick }) => [pick.kind, pick.name, pick.installs])).toStrictEqual([
      ['skill', 'pytest-pro', 900],
      ['skill', 'uv', 50],
      ['agent', 'python-pro', null],
      ['agent', 'fastapi-pro', null],
    ]);
    const agent = result.picks[2]?.pick;
    expect(agent).toMatchObject({
      description: 'Python expert',
      repo: VOLT,
      topic: 'Python',
      reason: PYTHON.reason,
    });
    expect(agent?.url).toContain('python-pro.md');
    // Only the chosen agents are read, not every file in the collections.
    expect(fake.urls.filter((url) => url.includes('raw.githubusercontent.com'))).toHaveLength(2);
  });

  it('does not pick the same thing twice across topics, and goes on when a source fails', async () => {
    const fake = github();
    fake.searchStatus = 500;
    const result = await findPicks(
      { reader: reader(fake), fetch: fake.fetch },
      [PYTHON, LATEX],
      new Set(),
    );
    expect(result.errors).toStrictEqual(['skills.sh: skills.sh answered 500.']);
    expect(result.picks.map(({ pick }) => `${pick.topic}:${pick.name}`)).toStrictEqual([
      'Python:python-pro',
      'Python:python-reviewer',
      'LaTeX:editor',
    ]);
    expect(fake.urls.filter((url) => url.startsWith('https://skills.sh'))).toHaveLength(1);
  });

  it('reports a collection that will not list and searches nothing without topics', async () => {
    const fake = github();
    fake.treeStatus = 404;
    const failed = await findPicks(
      { reader: reader(fake), fetch: fake.fetch },
      [PYTHON],
      new Set(),
    );
    expect(failed.errors).toHaveLength(3);
    expect(failed.picks.map(({ pick }) => pick.kind)).toStrictEqual(['skill', 'skill']);
    const idle = github();
    expect(
      await findPicks({ reader: reader(idle), fetch: idle.fetch }, [], new Set()),
    ).toStrictEqual({
      picks: [],
      errors: [],
    });
    expect(idle.urls).toStrictEqual([]);
  });
});
