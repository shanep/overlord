import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CODEX } from '../../../shared/agents.js';
import { createNodeFileSystem } from '../../context/fs.js';
import { resolveWithPolicy, type ResolvedContext } from '../../context/resolve.js';
import { gateContext, resolveInput } from '../../context/test-helpers/fixtures.js';
import type { ResolveInput } from '../../context/types.js';
import { resolveClaudePaths } from '../../paths.js';

import { codexInstructionPolicy, codexInstructions } from './instructions.js';

let root = '';

async function put(files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

function input(overrides: Partial<ResolveInput>): ResolveInput {
  const home = path.join(root, 'home');
  return resolveInput(
    { files: {} },
    {
      agentId: CODEX,
      fs: createNodeFileSystem(),
      paths: resolveClaudePaths({ home, platform: 'linux', env: {} }),
      ...overrides,
    },
  );
}

function short(file: string): string {
  return path.relative(root, file);
}

function loaded(result: ResolvedContext): [string, number][] {
  return result.expected.map((item) => [short(item.path), item.bytes]);
}

function skipped(result: ResolvedContext): [string, string][] {
  return result.skipped.map((item) => [short(item.path), item.code]);
}

const TREE = {
  'codex/AGENTS.override.md': 'override',
  'codex/AGENTS.md': 'global',
  'AGENTS.md': 'above the git root',
  'repo/AGENTS.md': 'root 10 b.',
  'repo/a/AGENTS.override.md': 'a override',
  'repo/a/AGENTS.md': 'a agents',
  'repo/a/b/TEAM.md': 'fifteen bytes!!',
  'repo/a/b/c/AGENTS.md': 'cwd',
  'repo/a/b/c/d/AGENTS.md': 'below cwd',
};

/** A session in repo/a/b/c with CODEX_HOME set. */
function session(): Partial<ResolveInput> {
  return {
    cwd: path.join(root, 'repo/a/b/c'),
    gitRoot: path.join(root, 'repo'),
    settings: { ...gateContext().settings, env: { CODEX_HOME: path.join(root, 'codex') } },
  };
}

describe('codexInstructions', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overlord-codex-')));
    await put(TREE);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads one file per folder from the git root down to cwd, override first', async () => {
    const result = await resolveWithPolicy(input(session()), codexInstructions);
    expect(loaded(result)).toStrictEqual([
      ['codex/AGENTS.override.md', 8],
      ['repo/AGENTS.md', 10],
      ['repo/a/AGENTS.override.md', 10],
      ['repo/a/b/c/AGENTS.md', 3],
    ]);
    expect(skipped(result)).toStrictEqual([
      ['codex/AGENTS.md', 'agents-md-shadowed'],
      ['repo/a/AGENTS.md', 'agents-md-shadowed'],
    ]);
    expect(result.skipped[1]?.detail).toBe(
      'AGENTS.override.md is in the same folder and comes first, so Codex reads only that one.',
    );
  });

  it('tries the fallback names and cuts the project files at project_doc_max_bytes', async () => {
    const policy = codexInstructionPolicy({ maxBytes: 30, fallbackFilenames: ['TEAM.md'] });
    const result = await resolveWithPolicy(input(session()), policy);
    expect(loaded(result)).toStrictEqual([
      ['codex/AGENTS.override.md', 8],
      ['repo/AGENTS.md', 10],
      ['repo/a/AGENTS.override.md', 10],
      ['repo/a/b/TEAM.md', 10],
    ]);
    expect(skipped(result)).toStrictEqual([
      ['codex/AGENTS.md', 'agents-md-shadowed'],
      ['repo/a/AGENTS.md', 'agents-md-shadowed'],
      ['repo/a/b/c/AGENTS.md', 'excluded'],
    ]);
    expect(result.expected[3]?.detail).toBe(
      'Loaded at launch. Only its first 10 of 15 bytes load, since project_doc_max_bytes caps the project files at 30 bytes.',
    );
    expect(result.skipped[2]?.detail).toBe(
      'The project files before it already fill project_doc_max_bytes (30 bytes), so Codex does not read it.',
    );
  });

  it('reads ~/.codex without CODEX_HOME, and only cwd outside git', async () => {
    await put({ 'home/.codex/AGENTS.md': 'home global' });
    const result = await resolveWithPolicy(
      input({ cwd: path.join(root, 'repo/a'), gitRoot: null }),
      codexInstructions,
    );
    expect(loaded(result).map(([file]) => file)).toStrictEqual([
      'home/.codex/AGENTS.md',
      'repo/a/AGENTS.override.md',
    ]);
  });
});
