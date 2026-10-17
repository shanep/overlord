import { readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isolatedExec } from '../sync/test-helpers/fixtures.js';

import { agentFile, FakeGitHub, skillFile } from './test-helpers/fake-github.js';
import type { RepoFiles } from './test-helpers/fake-github.js';
import type { EnvOptions, TestApp } from './test-helpers/fixtures.js';
import { cloneConfigRepo, makeApp, makeEnv, waitFor, writeText } from './test-helpers/fixtures.js';
import { buildLibrary } from './views/library.js';

const ANTHROPIC: RepoFiles = {
  'skills/pdf/SKILL.md': skillFile('pdf', 'Read and fill PDFs.'),
  'skills/pdf/scripts/fill.py': 'print("fill")',
  'skills/bad-name/SKILL.md': skillFile('plugin:pdf', 'Its frontmatter name will not do.'),
  'skills/-worse/SKILL.md': skillFile('also:bad', 'Neither will its folder.'),
};

const VOLT: RepoFiles = {
  'categories/01-core-development/api-designer.md': agentFile('api-designer', 'Designs APIs.'),
};

interface Setup {
  readonly test: TestApp;
  readonly github: FakeGitHub;
}

async function setup(options: EnvOptions = {}, exec = isolatedExec()): Promise<Setup> {
  const env = await makeEnv(options);
  const github = new FakeGitHub({
    'anthropics/skills': ANTHROPIC,
    'obra/superpowers': { 'skills/brainstorming/SKILL.md': skillFile('brainstorming', 'Ideas.') },
    'VoltAgent/awesome-claude-code-subagents': VOLT,
  });
  const test = makeApp(env, { deps: { fetch: github.fetch, exec } });
  return { test, github };
}

async function isFile(file: string): Promise<boolean> {
  const info = await stat(file);
  return info.isFile();
}

async function opened(test: TestApp, kind: 'skill' | 'agent'): Promise<void> {
  buildLibrary(test.app.runtime, kind);
  await waitFor(() => !buildLibrary(test.app.runtime, kind).catalog.loading);
}

function entryId(test: TestApp, kind: 'skill' | 'agent', name: string): string {
  const entry = buildLibrary(test.app.runtime, kind).catalog.entries.find(
    (candidate) => candidate.name === name,
  );
  if (entry === undefined) {
    throw new Error(`no ${name}`);
  }
  return entry.id;
}

describe('browsing premade skills and agents', () => {
  it('opens on the first collection and keeps a listed one', async () => {
    const { test, github } = await setup();
    const first = buildLibrary(test.app.runtime, 'skill');
    expect(first.kind).toBe('skill');
    expect(first.catalog).toMatchObject({ source: 'anthropics/skills', loading: true });
    expect(first.catalog.sources.map((source) => source.id)).toContain('skills.sh');
    await opened(test, 'skill');
    const listed = buildLibrary(test.app.runtime, 'skill').catalog;
    expect(listed.entries.map((entry) => entry.name)).toStrictEqual([
      'also:bad',
      'pdf',
      'plugin:pdf',
    ]);
    expect(listed.error).toBeNull();
    await test.app.dispatch(
      { type: 'browseCatalog', kind: 'skill', source: 'obra/superpowers' },
      {},
    );
    expect(
      buildLibrary(test.app.runtime, 'skill').catalog.entries.map((entry) => entry.name),
    ).toStrictEqual(['brainstorming']);
    await test.app.dispatch(
      { type: 'browseCatalog', kind: 'skill', source: 'anthropics/skills' },
      {},
    );
    expect(buildLibrary(test.app.runtime, 'skill').catalog.entries).toHaveLength(3);
    expect(github.treeCalls()).toBe(2);
    await test.app.dispatch({ type: 'browseCatalog', kind: 'skill', source: 'nowhere/else' }, {});
    expect(buildLibrary(test.app.runtime, 'skill').catalog.source).toBe('anthropics/skills');
  });

  it('lists installed items of its kind, without the built-in ones', async () => {
    const { test } = await setup();
    await writeText(
      path.join(test.env.paths.userSkillsDir, 'mine', 'SKILL.md'),
      skillFile('mine', 'x'),
    );
    await writeText(path.join(test.env.paths.userAgentsDir, 'helper.md'), agentFile('helper', 'x'));
    await test.app.runtime.caches.config.refresh();
    expect(
      buildLibrary(test.app.runtime, 'skill').installed.map((item) => item.name),
    ).toStrictEqual(['mine']);
    expect(
      buildLibrary(test.app.runtime, 'agent').installed.map((item) => item.name),
    ).toStrictEqual(['helper']);
  });

  it('says why a collection could not be listed', async () => {
    const { test, github } = await setup();
    github.treeStatus = 500;
    await opened(test, 'agent');
    expect(buildLibrary(test.app.runtime, 'agent').catalog.error).toBe(
      'Could not list https://github.com/VoltAgent/awesome-claude-code-subagents: GitHub answered 500 listing VoltAgent/awesome-claude-code-subagents.',
    );
  });

  it('searches skills.sh, asking for two characters first', async () => {
    const { test, github } = await setup();
    await test.app.dispatch({ type: 'browseCatalog', kind: 'skill', source: 'skills.sh' }, {});
    expect(buildLibrary(test.app.runtime, 'skill').catalog).toMatchObject({
      source: 'skills.sh',
      query: null,
      entries: [],
    });
    await test.app.dispatch({ type: 'searchCatalog', kind: 'skill', query: 'p' }, {});
    expect(buildLibrary(test.app.runtime, 'skill').catalog.error).toBe(
      'Type at least 2 characters to search skills.sh.',
    );
    github.hits = [
      {
        id: 'anthropics/skills/pdf',
        source: 'anthropics/skills',
        skillId: 'pdf',
        name: 'pdf',
        installs: 5,
      },
    ];
    await test.app.dispatch({ type: 'searchCatalog', kind: 'skill', query: 'pdf' }, {});
    expect(buildLibrary(test.app.runtime, 'skill').catalog).toMatchObject({
      query: 'pdf',
      error: null,
      entries: [{ name: 'pdf', installs: 5 }],
    });
    github.searchStatus = 503;
    await test.app.dispatch({ type: 'searchCatalog', kind: 'skill', query: 'pdf' }, {});
    expect(buildLibrary(test.app.runtime, 'skill').catalog).toMatchObject({
      entries: [],
      error: 'Could not search skills.sh: skills.sh answered 503.',
    });
    await test.app.dispatch({ type: 'searchCatalog', kind: 'agent', query: 'pdf' }, {});
    expect(buildLibrary(test.app.runtime, 'agent').catalog.query).toBeNull();
  });

  it('opens pages the catalog listed and nothing else', async () => {
    const { test } = await setup();
    await opened(test, 'skill');
    const urls = [
      'https://github.com/anthropics/skills',
      'https://github.com/anthropics/skills/tree/HEAD/skills/pdf',
      'https://evil.example',
    ];
    for (const url of urls) {
      await test.app.dispatch({ type: 'openCatalogLink', kind: 'skill', url }, {});
    }
    expect(test.env.host.external).toStrictEqual(urls.slice(0, 2));
  });
});

describe('installing a premade skill or agent', () => {
  it('copies a skill folder into ~/.claude and opens it', async () => {
    const { test } = await setup();
    await opened(test, 'skill');
    test.env.host.pickAnswers.push('user');
    await test.app.dispatch(
      { type: 'installCatalog', kind: 'skill', entryId: entryId(test, 'skill', 'pdf') },
      {},
    );
    const folder = path.join(test.env.paths.userSkillsDir, 'pdf');
    expect(await readFile(path.join(folder, 'SKILL.md'), 'utf8')).toBe(
      ANTHROPIC['skills/pdf/SKILL.md'],
    );
    expect(await readFile(path.join(folder, 'scripts', 'fill.py'), 'utf8')).toBe('print("fill")');
    expect(test.env.host.opened).toStrictEqual([path.join(folder, 'SKILL.md')]);
    expect(buildLibrary(test.app.runtime, 'skill').catalog).toMatchObject({
      installing: null,
      notice: {
        ok: true,
        text: expect.stringContaining('Installed pdf from anthropics/skills') as unknown,
      },
    });
    expect(buildLibrary(test.app.runtime, 'skill').installed.map((item) => item.name)).toContain(
      'pdf',
    );
  });

  it('copies an agent file into the project', async () => {
    const { test } = await setup({ workspace: true });
    await opened(test, 'agent');
    test.env.host.pickAnswers.push('project');
    await test.app.dispatch(
      { type: 'installCatalog', kind: 'agent', entryId: entryId(test, 'agent', 'api-designer') },
      {},
    );
    const workspace = test.env.host.workspace ?? '';
    const file = path.join(workspace, '.claude', 'agents', 'api-designer.md');
    expect(await readFile(file, 'utf8')).toBe(
      VOLT['categories/01-core-development/api-designer.md'],
    );
  });

  it('installs a skills.sh result found by its folder', async () => {
    const { test, github } = await setup();
    github.hits = [
      { id: 'anthropics/skills/pdf', source: 'anthropics/skills', skillId: 'pdf', name: 'pdf' },
    ];
    await test.app.dispatch({ type: 'searchCatalog', kind: 'skill', query: 'pdf' }, {});
    test.env.host.pickAnswers.push('user');
    await test.app.dispatch(
      { type: 'installCatalog', kind: 'skill', entryId: 'skills.sh:anthropics/skills/pdf' },
      {},
    );
    expect(await isFile(path.join(test.env.paths.userSkillsDir, 'pdf', 'scripts', 'fill.py'))).toBe(
      true,
    );
  });

  it('falls back to the folder name, and refuses a folder name Claude Code would not load', async () => {
    const { test } = await setup();
    await opened(test, 'skill');
    test.env.host.pickAnswers.push('user');
    await test.app.dispatch(
      { type: 'installCatalog', kind: 'skill', entryId: entryId(test, 'skill', 'plugin:pdf') },
      {},
    );
    expect(await isFile(path.join(test.env.paths.userSkillsDir, 'bad-name', 'SKILL.md'))).toBe(
      true,
    );
    await test.app.dispatch(
      { type: 'installCatalog', kind: 'skill', entryId: entryId(test, 'skill', 'also:bad') },
      {},
    );
    expect(buildLibrary(test.app.runtime, 'skill').catalog.notice).toMatchObject({
      ok: false,
      text: expect.stringMatching(/^"-worse" cannot be installed under that name/u) as unknown,
    });
  });

  it('stops quietly when the user backs out of where it goes or of replacing', async () => {
    const { test } = await setup();
    await opened(test, 'skill');
    const id = entryId(test, 'skill', 'pdf');
    await test.app.dispatch({ type: 'installCatalog', kind: 'skill', entryId: id }, {});
    expect(buildLibrary(test.app.runtime, 'skill').catalog).toMatchObject({
      installing: null,
      notice: null,
    });
    const old = path.join(test.env.paths.userSkillsDir, 'pdf', 'old.md');
    await writeText(old, 'old');
    test.env.host.pickAnswers.push('user');
    await test.app.dispatch({ type: 'installCatalog', kind: 'skill', entryId: id }, {});
    expect(test.env.host.questions.at(-1)?.action).toBe('Replace');
    expect(await readFile(old, 'utf8')).toBe('old');
    test.env.host.pickAnswers.push('user');
    test.env.host.confirmAnswers.push(true);
    await test.app.dispatch({ type: 'installCatalog', kind: 'skill', entryId: id }, {});
    await expect(stat(old)).rejects.toThrow();
    expect(await isFile(path.join(test.env.paths.userSkillsDir, 'pdf', 'SKILL.md'))).toBe(true);
  });

  it('says when the entry is not listed any more', async () => {
    const { test } = await setup();
    await test.app.dispatch({ type: 'installCatalog', kind: 'agent', entryId: 'gone' }, {});
    expect(buildLibrary(test.app.runtime, 'agent').catalog.notice).toStrictEqual({
      ok: false,
      text: 'That one is not in the list any more. Pick it again.',
    });
  });

  it('writes user scope into the config repo and links it back', async () => {
    const exec = isolatedExec();
    const { test } = await setup({}, exec);
    const repo = await cloneConfigRepo(test.env, exec);
    await opened(test, 'agent');
    test.env.host.pickAnswers.push('user');
    await test.app.dispatch(
      { type: 'installCatalog', kind: 'agent', entryId: entryId(test, 'agent', 'api-designer') },
      {},
    );
    const inRepo = path.join(repo, 'agents', 'api-designer.md');
    expect(await readlink(path.join(test.env.paths.userAgentsDir, 'api-designer.md'))).toBe(inRepo);
    expect(test.env.host.opened).toStrictEqual([inRepo]);
  });
});
