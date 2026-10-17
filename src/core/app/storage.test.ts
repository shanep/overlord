import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AutoApproveRule } from '../../shared/protocol.js';

import {
  parseRule,
  readDrafts,
  readImport,
  readProjects,
  readRules,
  STORAGE_FILES,
  storagePath,
  writeImport,
  writeProjects,
  writeRules,
} from './storage.js';
import { makeEnv, readJson, writeJson, writeText } from './test-helpers/fixtures.js';

const RULE: AutoApproveRule = {
  id: 'r1',
  enabled: true,
  behavior: 'allow',
  tool: 'Bash',
  pattern: 'git status*',
  description: 'status is safe',
};

describe('storagePath', () => {
  it('joins the storage folder with each known file name', () => {
    expect(storagePath('/s', 'rules')).toBe(path.join('/s', 'rules.json'));
    expect(STORAGE_FILES).toStrictEqual({
      rules: 'rules.json',
      audit: 'audit.jsonl',
      profiles: 'profiles.json',
      drafts: 'drafts.json',
      claudeAi: 'claude-ai.json',
      memoryState: 'memory-state.json',
      dryRun: 'dry-run.txt',
      projects: 'projects.json',
      launched: 'launched.json',
    });
  });
});

describe('rules file', () => {
  it('reads as empty when missing and round trips what was written', async () => {
    const env = await makeEnv();
    const file = path.join(env.storageDir, 'rules.json');
    await expect(readRules(file)).resolves.toStrictEqual([]);
    await writeRules(file, [RULE]);
    await expect(readRules(file)).resolves.toStrictEqual([RULE]);
    await expect(readJson(file)).resolves.toStrictEqual({ version: 1, rules: [RULE] });
    expect(await readFile(file, 'utf8')).toMatch(/\n {2}"version": 1,\n[\s\S]*\}\n$/u);
  });

  it('rejects text that is not JSON and JSON in the wrong shape', async () => {
    const env = await makeEnv();
    const bad = await writeText(path.join(env.root, 'bad.json'), '{nope');
    await expect(readRules(bad)).rejects.toThrow(`${bad} is not valid JSON`);
    const wrong = await writeJson(path.join(env.root, 'wrong.json'), { version: 2, rules: [] });
    await expect(readRules(wrong)).rejects.toThrow(`${wrong} is not in the expected format`);
  });

  it('checks single rules', () => {
    expect(parseRule(RULE)).toStrictEqual(RULE);
    expect(parseRule({ ...RULE, id: '' })).toBeNull();
    expect(parseRule({ ...RULE, tool: '' })).toBeNull();
    expect(parseRule({ ...RULE, behavior: 'maybe' })).toBeNull();
    expect(parseRule({ ...RULE, pattern: null })).toStrictEqual({ ...RULE, pattern: null });
  });
});

describe('drafts file', () => {
  it('reads drafts and treats a missing file as none', async () => {
    const env = await makeEnv();
    const file = path.join(env.storageDir, 'drafts.json');
    await expect(readDrafts(file)).resolves.toStrictEqual([]);
    const drafts = [{ id: 'd1', label: 'Fix', prompt: 'fix it' }];
    await writeJson(file, { version: 1, drafts });
    await expect(readDrafts(file)).resolves.toStrictEqual(drafts);
  });
});

describe('claude.ai import file', () => {
  it('keeps titles and times only and rebuilds claude.ai rows', async () => {
    const env = await makeEnv();
    const file = path.join(env.storageDir, 'claude-ai.json');
    await expect(readImport(file)).resolves.toBeNull();
    await writeImport(file, {
      importedAt: 42,
      sessions: [
        {
          id: 'c1',
          agent: 'claude-code',
          surface: 'claude-ai',
          title: 'Chat',
          cwd: '/ignored',
          updatedAt: 7,
          archived: true,
          handoffs: ['resume-local'],
        },
      ],
    });
    await expect(readJson(file)).resolves.toStrictEqual({
      version: 1,
      importedAt: 42,
      sessions: [{ id: 'c1', title: 'Chat', updatedAt: 7 }],
    });
    await expect(readImport(file)).resolves.toStrictEqual({
      importedAt: 42,
      sessions: [
        {
          id: 'c1',
          agent: 'claude-code',
          title: 'Chat',
          updatedAt: 7,
          surface: 'claude-ai',
          cwd: null,
          archived: false,
          handoffs: [],
        },
      ],
    });
  });

  it('reads a stored null as no import', async () => {
    const env = await makeEnv();
    const file = await writeText(path.join(env.root, 'claude-ai.json'), 'null');
    await expect(readImport(file)).resolves.toBeNull();
  });
});

describe('projects file', () => {
  it('reads nothing as an empty book and reads back what it wrote', async () => {
    const env = await makeEnv();
    const file = storagePath(env.storageDir, 'projects');
    expect(await readProjects(file)).toStrictEqual({ projects: [], rules: [], repos: [] });
    const book = {
      projects: [{ id: 'p1', name: 'Course', folder: null }],
      rules: [
        { folder: '/notes', projectId: 'p1' },
        { folder: '/tmp', projectId: null },
      ],
      repos: ['/repo'],
    };
    await writeProjects(file, book);
    expect(await readJson(file)).toStrictEqual({ version: 1, ...book });
    expect(await readProjects(file)).toStrictEqual(book);
  });

  it('reads a file saved before projects had folders or repositories as having none', async () => {
    const env = await makeEnv();
    const file = storagePath(env.storageDir, 'projects');
    await writeJson(file, { version: 1, projects: [{ id: 'p1', name: 'Course' }], rules: [] });
    expect(await readProjects(file)).toStrictEqual({
      projects: [{ id: 'p1', name: 'Course', folder: null }],
      rules: [],
      repos: [],
    });
  });

  it('rejects a file in the wrong shape', async () => {
    const env = await makeEnv();
    const file = storagePath(env.storageDir, 'projects');
    await writeJson(file, {
      version: 1,
      projects: [{ id: '', name: 'x', folder: null }],
      rules: [],
    });
    await expect(readProjects(file)).rejects.toThrow('not in the expected format');
  });
});
