import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agents } from '../agents/index.js';
import { resolveClaudePaths, type ClaudePaths } from '../paths.js';

import {
  agentDirs,
  dialectsOf,
  exportingAgents,
  hookedAgents,
  telemetryConfig,
  telemetryDecoder,
} from './agent-talk.js';

function logs(service: string, event: string): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: event },
                attributes: [
                  { key: 'event.name', value: { stringValue: event } },
                  { key: 'conversation.id', value: { stringValue: 'thr' } },
                  { key: 'session.id', value: { stringValue: 'ses' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('agent talk', () => {
  let home: string;
  let paths: ClaudePaths;
  const codexHome = (): string => path.join(home, '.codex');

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'ovl-agent-talk-'));
    paths = resolveClaudePaths({ home, platform: 'linux', env: {} });
    await mkdir(codexHome(), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("finds each agent's folder, CODEX_HOME included", () => {
    const codex = agents.get('codex');
    expect(codex === null ? null : agentDirs(codex, paths, {})).toStrictEqual({
      home,
      configDir: codexHome(),
    });
    expect(codex === null ? null : agentDirs(codex, paths, { CODEX_HOME: '/x' })).toStrictEqual({
      home,
      configDir: '/x',
    });
  });

  it('lists Codex once its hooks.json has Overlord hooks, and reads its relay with its dialect', async () => {
    expect(await hookedAgents(agents, paths, {})).toStrictEqual([]);
    const codex = agents.get('codex');
    const dirs = codex === null ? null : agentDirs(codex, paths, {});
    if (codex?.hooks === undefined || dirs === null) {
      throw new Error('Codex has hooks');
    }
    await codex.hooks.install(dirs, 'node "/h/overlord-hook.cjs"');
    const hooked = await hookedAgents(agents, paths, {});
    expect(hooked.map((adapter) => adapter.id)).toStrictEqual(['codex']);
    expect(dialectsOf(agents)('codex')).toBe(codex.hooks);
    expect(dialectsOf(agents)('nobody')).toBeNull();
  });

  it('lists Codex once its config.toml exports to Overlord, and only then', async () => {
    expect(await exportingAgents(agents, paths, {})).toStrictEqual([]);
    await writeFile(path.join(codexHome(), 'config.toml'), 'model = "x"\n');
    expect(await exportingAgents(agents, paths, {})).toStrictEqual([]);
    await agents.get('codex')?.telemetry?.enable({ home, configDir: codexHome() }, 4318);
    const exporting = await exportingAgents(agents, paths, {});
    expect(exporting.map((adapter) => adapter.id)).toStrictEqual(['codex']);
  });

  it('gives a Codex launch the export only while the receiver runs, and Claude none', async () => {
    const launch = { registry: agents, paths, env: {} };
    expect(await telemetryConfig({ ...launch, port: null }, 'codex')).toStrictEqual([]);
    expect(await telemetryConfig({ ...launch, port: 4318 }, 'claude-code')).toStrictEqual([]);
    expect(await telemetryConfig({ ...launch, port: 4318 }, 'codex')).toHaveLength(3);
  });

  it("sends a Codex export to Codex's decoder and anything else to Claude Code's", () => {
    const decode = telemetryDecoder(agents);
    expect(decode('logs', logs('codex_exec', 'codex.turn_ttft'), 0)).toMatchObject([
      { kind: 'event', name: 'turn_ttft', sessionId: 'thr' },
    ]);
    expect(decode('logs', logs('claude-code', 'claude_code.user_prompt'), 0)).toMatchObject([
      { kind: 'user_prompt', sessionId: 'ses' },
    ]);
  });
});
