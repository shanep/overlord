import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE, CODEX, COPILOT } from '../../shared/agents.js';

import {
  customAgent,
  NO_CUSTOM_AGENTS,
  parseCustomAgents,
  trackCustomAgents,
  type CustomAgentSpec,
} from './custom.js';
import { AgentRegistry } from './registry.js';

import { agents } from './index.js';

const RESERVED = new Set([CLAUDE_CODE, CODEX, COPILOT]);
const SECRET = 'sk-do-not-show-me';

function skipped(which: string, why: string): string {
  return `overlord.customAgents entry ${which} ${why}, so Overlord skipped it.`;
}

const GEMINI: CustomAgentSpec = {
  id: 'gemini',
  name: 'Gemini CLI',
  command: 'gemini',
  args: ['--experimental-acp'],
  env: {},
  icon: 'terminal',
  modes: [],
};

describe('parseCustomAgents', () => {
  it('reads entries and fills in what they leave out', () => {
    const setting = parseCustomAgents(
      [
        { id: 'gemini', name: ' Gemini CLI ', command: ' gemini ', args: ['--experimental-acp'] },
        {
          id: 'my.agent_2',
          name: 'Mine',
          command: '/opt/mine/bin/mine',
          env: { API_KEY: SECRET },
          icon: 'robot',
          modes: [{ id: 'ask' }, { id: 'yolo', label: 'Yolo', risky: true }],
        },
      ],
      RESERVED,
    );
    expect(setting.problems).toStrictEqual([]);
    expect(setting.agents).toStrictEqual([
      GEMINI,
      {
        id: 'my.agent_2',
        name: 'Mine',
        command: '/opt/mine/bin/mine',
        args: [],
        env: { API_KEY: SECRET },
        icon: 'robot',
        modes: [
          { id: 'ask', label: 'ask' },
          { id: 'yolo', label: 'Yolo', risky: true },
        ],
      },
    ]);
  });

  it('takes a missing or empty setting as no agents', () => {
    expect(parseCustomAgents(undefined, RESERVED)).toBe(NO_CUSTOM_AGENTS);
    expect(parseCustomAgents(null, RESERVED)).toBe(NO_CUSTOM_AGENTS);
    expect(parseCustomAgents([], RESERVED)).toStrictEqual(NO_CUSTOM_AGENTS);
  });

  it('ignores a setting that is not a list', () => {
    expect(parseCustomAgents({ id: 'gemini' }, RESERVED)).toStrictEqual({
      agents: [],
      problems: ['overlord.customAgents should be a list of agents, so it was ignored.'],
    });
  });

  it('skips each broken or clashing entry with a line that names it', () => {
    const good = { id: 'ok', name: 'Ok', command: 'ok' };
    const setting = parseCustomAgents(
      [
        'gemini',
        { ...good, id: 'has space' },
        { ...good, id: CODEX },
        good,
        { ...good, name: 'Again' },
        { ...good, id: 'a', name: '' },
        { ...good, id: 'b', command: 3 },
        { ...good, id: 'c', args: '--acp' },
        { ...good, id: 'd', env: { API_KEY: SECRET, PORT: 8080 } },
        { ...good, id: 'e', icon: 'Not An Icon' },
        { ...good, id: 'f', modes: [{ label: 'No id' }] },
        { ...good, id: 'g', modes: [{ id: 'x', risky: 'yes' }] },
        { ...good, id: 'h', modes: 'ask' },
      ],
      RESERVED,
    );
    expect(setting.agents.map((agent) => agent.id)).toStrictEqual(['ok']);
    expect(setting.problems).toStrictEqual([
      skipped('1', 'is not an object'),
      skipped('2', 'needs an id made of letters, digits, dots, dashes and underscores'),
      skipped('3 ("codex")', 'has the id of a built-in agent'),
      skipped('5 ("ok")', 'has the same id as an earlier entry'),
      skipped('6 ("a")', 'needs a name'),
      skipped('7 ("b")', 'needs a command'),
      skipped('8 ("c")', 'has args that are not a list of strings'),
      skipped('9 ("d")', 'has an env whose values are not all strings'),
      skipped('10 ("e")', 'has an icon that is not a codicon id'),
      skipped('11 ("f")', 'has modes that are not a list of { id, label?, risky? }'),
      skipped('12 ("g")', 'has modes that are not a list of { id, label?, risky? }'),
      skipped('13 ("h")', 'has modes that are not a list of { id, label?, risky? }'),
    ]);
    expect(setting.problems.join('\n')).not.toContain(SECRET);
  });
});

describe('customAgent', () => {
  it('can launch, approve and interrupt, and nothing else', () => {
    const adapter = customAgent(GEMINI);
    expect(adapter).toMatchObject({ id: 'gemini', name: 'Gemini CLI', short: 'Gemini CLI' });
    expect(adapter.capabilities).toStrictEqual({
      launch: true,
      terminal: false,
      background: false,
      resume: false,
      fork: false,
      interrupt: true,
      liveModelChange: false,
      livePermissionMode: false,
      approvals: true,
      subagents: false,
      cacheReads: false,
      cacheWrites: false,
      costUsd: false,
      contextInspector: false,
      hooks: false,
      messaging: false,
      handoffs: [],
    });
    expect(adapter.runtime?.permissionSource).toBe('runtime');
    expect(adapter.terminal).toBeUndefined();
    expect(adapter.observer).toBeUndefined();
    expect(adapter.hooks).toBeUndefined();
    expect(adapter.config).toBeUndefined();
    expect(adapter.models.contextWindow('any')).toBeNull();
    expect(adapter.models.price('any')).toBeNull();
  });

  it('offers its modes and switching between them', () => {
    const modes = [{ id: 'ask', label: 'Ask' }];
    const adapter = customAgent({ ...GEMINI, modes });
    expect(adapter.modes).toStrictEqual({ permission: modes, effort: [] });
    expect(adapter.capabilities.livePermissionMode).toBe(true);
  });

  it('is installed when its command is on the login PATH or at its absolute path', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'overlord-custom-'));
    const bin = path.join(dir, 'gemini');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    const onPath = customAgent(GEMINI);
    const detect = { platform: 'linux' as const, path: '' };
    await expect(onPath.detect({ ...detect, env: { PATH: dir } })).resolves.toStrictEqual({
      bin,
      version: null,
    });
    await expect(onPath.detect({ ...detect, env: { PATH: '/nowhere' } })).resolves.toStrictEqual({
      bin: null,
      version: null,
    });
    const absolute = customAgent({ ...GEMINI, command: bin });
    await expect(absolute.detect({ ...detect, env: {} })).resolves.toMatchObject({ bin });
    const missing = customAgent({ ...GEMINI, command: path.join(dir, 'missing') });
    await expect(missing.detect({ ...detect, env: {} })).resolves.toMatchObject({ bin: null });
    const relative = customAgent({ ...GEMINI, command: './gemini' });
    await expect(relative.detect({ ...detect, env: { PATH: dir } })).resolves.toMatchObject({
      bin: null,
    });
  });
});

describe('trackCustomAgents', () => {
  it('swaps the registry custom agents on each update and warns once per problem', () => {
    const registry = new AgentRegistry(agents.list().slice(0, 1));
    const warnings: string[] = [];
    const host = {
      settings: {
        customAgents: parseCustomAgents(
          [
            { id: 'gemini', name: 'Gemini', command: 'gemini' },
            { id: CLAUDE_CODE, name: 'Claude', command: 'claude' },
          ],
          registry.builtInIds(),
        ),
      },
      showWarning: (message: string): void => {
        warnings.push(message);
      },
    };
    const update = trackCustomAgents(registry, host);
    expect(registry.list().map((adapter) => adapter.id)).toStrictEqual([CLAUDE_CODE, 'gemini']);
    update();
    expect(warnings).toStrictEqual([
      'overlord.customAgents entry 2 ("claude-code") has the id of a built-in agent, so Overlord skipped it.',
    ]);
    host.settings.customAgents = NO_CUSTOM_AGENTS;
    update();
    expect(registry.get('gemini')).toBeNull();
  });
});
