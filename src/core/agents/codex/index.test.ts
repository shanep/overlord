import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLAUDE_CODE, CODEX } from '../../../shared/agents.js';
import { resolveContext } from '../../context/resolve.js';
import { CWD, resolveInput } from '../../context/test-helpers/fixtures.js';
import { agents } from '../index.js';

import { codexInstructions } from './instructions.js';

import { codex } from './index.js';

describe('the context resolver for a Codex session', () => {
  const tree = {
    files: {
      '/home/u/.codex/AGENTS.md': 'codex user file',
      [`${CWD}/CLAUDE.md`]: 'claude project file',
      [`${CWD}/AGENTS.override.md`]: 'codex override',
      [`${CWD}/AGENTS.md`]: 'shadowed by the override',
    },
  };

  it("runs Codex's instruction policy, not Claude's", async () => {
    expect(codex.instructions).toBe(codexInstructions);
    const result = await resolveContext(resolveInput(tree, { agentId: CODEX }));
    expect(result.expected.map((item) => item.path)).toStrictEqual([
      '/home/u/.codex/AGENTS.md',
      `${CWD}/AGENTS.override.md`,
    ]);
    const claude = await resolveContext(resolveInput(tree, { agentId: CLAUDE_CODE }));
    expect(claude.expected.map((item) => item.path)).toContain(`${CWD}/CLAUDE.md`);
  });
});

describe('codex', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-agent-codex-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names itself and is registered after Claude Code', () => {
    expect([codex.id, codex.name, codex.short]).toStrictEqual(['codex', 'Codex CLI', 'Codex']);
    expect(
      agents
        .list()
        .map((adapter) => adapter.id)
        .slice(0, 2),
    ).toStrictEqual(['claude-code', 'codex']);
    expect(agents.get('codex')).toBe(codex);
  });

  it('claims only what the rollout files give it', () => {
    expect(codex.capabilities).toMatchObject({
      launch: false,
      terminal: true,
      resume: true,
      fork: true,
      background: false,
      interrupt: false,
      approvals: false,
      hooks: false,
      cacheReads: true,
      costUsd: false,
      handoffs: ['resume-local'],
    });
  });

  it('pairs approval policy with sandbox mode and marks full access risky', () => {
    const ids = codex.modes.permission.map((mode) => mode.id);
    expect(ids).toHaveLength(9);
    expect(ids).toContain('on-request/workspace-write');
    const risky = codex.modes.permission.filter((mode) => mode.risky === true);
    expect(risky.map((mode) => mode.id)).toStrictEqual([
      'untrusted/danger-full-access',
      'on-request/danger-full-access',
      'never/danger-full-access',
    ]);
    expect(
      codex.modes.permission.find((mode) => mode.id === 'never/danger-full-access')?.label,
    ).toBe('Full access, never ask');
    expect(codex.modes.effort.map((mode) => mode.id)).toStrictEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('finds the codex binary on PATH without running it', async () => {
    const bin = path.join(dir, 'codex');
    await writeFile(bin, '#!/bin/sh\nexit 1\n');
    await chmod(bin, 0o755);
    const found = await codex.detect({ env: { PATH: dir }, platform: 'linux', path: '' });
    expect(found).toStrictEqual({ bin, version: null });
    const missing = await codex.detect({
      env: { PATH: path.join(dir, 'none') },
      platform: 'linux',
      path: '',
    });
    expect(missing).toStrictEqual({ bin: null, version: null });
  });
});
