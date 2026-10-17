import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COPILOT } from '../../../shared/agents.js';
import { createNodeFileSystem } from '../../context/fs.js';
import { resolveWithPolicy, type ResolvedContext } from '../../context/resolve.js';
import { gateContext, resolveInput } from '../../context/test-helpers/fixtures.js';
import type { ResolveInput } from '../../context/types.js';
import { resolveClaudePaths } from '../../paths.js';

import { copilotInstructions } from './instructions.js';

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
      agentId: COPILOT,
      fs: createNodeFileSystem(),
      paths: resolveClaudePaths({ home, platform: 'linux', env: {} }),
      ...overrides,
    },
  );
}

function short(file: string): string {
  return path.relative(root, file);
}

function under(result: ResolvedContext): {
  readonly loaded: string[];
  readonly skipped: [string, string][];
} {
  return {
    loaded: result.expected.map((item) => short(item.path)),
    skipped: result.skipped.map((item) => [short(item.path), item.code]),
  };
}

describe('copilotInstructions', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overlord-copilot-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads the git root, cwd and the nearest folder between, and nothing above or below', async () => {
    await put({
      'home/.copilot/copilot-instructions.md': 'mine',
      'home/.copilot/instructions/py.instructions.md': '---\napplyTo: "**/*.py"\n---\npython',
      'AGENTS.md': 'above the git root',
      'repo/.github/copilot-instructions.md': 'repo',
      'repo/AGENTS.md': 'agents',
      'repo/CLAUDE.md': 'claude',
      'repo/GEMINI.md': 'gemini',
      'repo/CLAUDE.local.md': 'Claude only',
      'repo/.claude/CLAUDE.md': 'Claude only',
      'repo/.github/instructions/ts.instructions.md': '---\napplyTo: "**/*.ts,docs/**"\n---\nts',
      'repo/.github/instructions/notes.md': 'not an instructions file',
      'repo/.claude/rules/src.md': '---\npaths:\n  - "src/**"\n---\nsrc',
      'repo/.claude/rules/agent.md': '---\nexcludeAgent: "coding-agent"\n---\nno',
      'repo/a/AGENTS.md': 'farther',
      'repo/a/b/CLAUDE.md': 'nearest',
      'repo/a/b/GEMINI.md': 'nearest, second',
      'repo/a/b/c/AGENTS.md': 'cwd',
      'repo/a/b/c/d/AGENTS.md': 'below cwd',
    });
    const cwd = path.join(root, 'repo/a/b/c');
    const result = await resolveWithPolicy(
      input({
        cwd,
        gitRoot: path.join(root, 'repo'),
        touchedFiles: [path.join(cwd, 'main.ts')],
      }),
      copilotInstructions,
    );
    expect(under(result)).toStrictEqual({
      loaded: [
        'home/.copilot/copilot-instructions.md',
        'repo/.github/copilot-instructions.md',
        'repo/AGENTS.md',
        'repo/CLAUDE.md',
        'repo/GEMINI.md',
        'repo/.github/instructions/ts.instructions.md',
        'repo/a/b/CLAUDE.md',
        'repo/a/b/c/AGENTS.md',
      ],
      skipped: [
        ['home/.copilot/instructions/py.instructions.md', 'glob-not-matched'],
        ['repo/.claude/rules/agent.md', 'excluded'],
        ['repo/.claude/rules/src.md', 'glob-not-matched'],
        ['repo/a/AGENTS.md', 'agents-md-shadowed'],
        ['repo/a/b/GEMINI.md', 'excluded'],
        ['repo/a/b/c/.github/copilot-instructions.md', 'missing'],
      ],
    });
    expect(result.memoryDir).toBeNull();
    const details = new Map(result.skipped.map((item) => [path.relative(root, item.path), item]));
    expect(details.get('repo/a/b/GEMINI.md')?.detail).toBe(
      'Of the folders between the git root and the working directory, Copilot reads only the first file of the nearest one that has any, which is a/b/CLAUDE.md.',
    );
    expect(details.get('repo/.claude/rules/src.md')?.detail).toBe(
      'Its applyTo globs (src/**) have not matched a file Copilot touched.',
    );
    expect(details.get('repo/.claude/rules/agent.md')?.detail).toContain('excludeAgent');
  });

  it('takes cwd as the whole project outside git', async () => {
    await put({ 'plain/AGENTS.md': 'parent', 'plain/inner/AGENTS.md': 'cwd' });
    const result = await resolveWithPolicy(
      input({ cwd: path.join(root, 'plain/inner'), gitRoot: null }),
      copilotInstructions,
    );
    expect(under(result).loaded).toStrictEqual(['plain/inner/AGENTS.md']);
  });

  it('finds the user file under COPILOT_HOME', async () => {
    await put({ 'elsewhere/copilot-instructions.md': 'moved', 'repo/AGENTS.md': 'agents' });
    const settings = {
      ...gateContext().settings,
      env: { COPILOT_HOME: path.join(root, 'elsewhere') },
    };
    const cwd = path.join(root, 'repo');
    const result = await resolveWithPolicy(
      input({ cwd, gitRoot: cwd, settings }),
      copilotInstructions,
    );
    expect(under(result).loaded).toStrictEqual([
      'elsewhere/copilot-instructions.md',
      'repo/AGENTS.md',
    ]);
  });
});
