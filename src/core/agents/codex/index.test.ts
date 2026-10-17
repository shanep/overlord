import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLAUDE_CODE, CODEX } from '../../../shared/agents.js';
import { loadConnectors } from '../../app/views/connectors-data.js';
import { resolveContext } from '../../context/resolve.js';
import { CWD, resolveInput } from '../../context/test-helpers/fixtures.js';
import { resolveClaudePaths } from '../../paths.js';
import { agents } from '../index.js';
import { AgentRegistry } from '../registry.js';

import { codexKnobs } from './config.js';
import { codexHooks } from './hooks.js';
import { codexInject } from './inject.js';
import { codexInstructions } from './instructions.js';
import { codexLibrary } from './library.js';
import { codexMcp } from './mcp.js';
import { codexSync } from './sync.js';
import { codexTelemetry } from './telemetry.js';

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

  it('claims what the rollout files, app-server and its hooks give it', () => {
    expect(codex.runtime?.permissionSource).toBe('runtime');
    expect(codex.capabilities).toMatchObject({
      launch: true,
      terminal: true,
      resume: true,
      fork: true,
      background: false,
      interrupt: true,
      approvals: true,
      liveModelChange: true,
      livePermissionMode: true,
      hooks: true,
      cacheReads: true,
      costUsd: false,
      handoffs: ['resume-local'],
    });
  });

  it('hooks, injects, exports and tunes through its own files', () => {
    expect(codex.hooks).toBe(codexHooks);
    expect(codex.inject).toBe(codexInject);
    expect(codex.telemetry).toBe(codexTelemetry);
    expect(codex.config).toStrictEqual({
      settingsFormat: 'toml',
      mcp: codexMcp,
      knobs: codexKnobs,
      library: codexLibrary,
      sync: codexSync,
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

describe('the Connectors data with Codex installed', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-codex-connectors-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists the servers in $CODEX_HOME/config.toml as Codex rows', async () => {
    const bin = path.join(dir, 'bin');
    const codexHome = path.join(dir, 'codex-home');
    const home = path.join(dir, 'home');
    await Promise.all([mkdir(bin), mkdir(codexHome), mkdir(home)]);
    await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n');
    await chmod(path.join(bin, 'codex'), 0o755);
    await writeFile(
      path.join(codexHome, 'config.toml'),
      '# kept by hand\n[mcp_servers.docs]\ncommand = "docs-mcp"\nargs = ["--stdio"]\n',
    );
    const data = await loadConnectors({
      claudeCli: async () => {
        await Promise.resolve();
        return { bin: 'claude', env: {} };
      },
      loginEnv: async () => {
        await Promise.resolve();
        return { PATH: bin, CODEX_HOME: codexHome };
      },
      registry: new AgentRegistry([codex]),
      agentPath: () => '',
      agentEnabled: () => true,
      workspace: null,
      paths: resolveClaudePaths({ home, platform: 'linux', env: {} }),
      platform: 'linux',
      exec: async () => {
        await Promise.resolve();
        return { code: 1, stdout: '', stderr: 'no claude here' };
      },
      callTool: async () => {
        await Promise.resolve();
        return '[]';
      },
      clock: () => 1,
    });
    expect(data.mcpAgents).toStrictEqual([CLAUDE_CODE, CODEX]);
    const codexRow = data.connectors.find((row) => row.agent === CODEX);
    expect(codexRow).toMatchObject({
      id: 'codex/mcp:docs',
      name: 'docs',
      status: 'unchecked',
      target: 'docs-mcp --stdio',
    });
    expect(codexRow?.detail).toContain(path.join(codexHome, 'config.toml'));
  });
});
