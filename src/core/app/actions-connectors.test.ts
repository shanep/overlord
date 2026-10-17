import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Connector } from '../../shared/connectors.js';
import { claudeCode } from '../agents/claude/index.js';
import { codexMcp } from '../agents/codex/mcp.js';
import { copilot } from '../agents/copilot/index.js';
import { agents } from '../agents/index.js';
import type { AgentAdapter, Detected } from '../agents/types.js';
import type { FetchFunction } from '../sync/github.js';

import type { Responder } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, ok } from './test-helpers/fixtures.js';
import { buildConnectors, sessionBriefing } from './views/connectors.js';

const DOCS: Connector = {
  id: 'codex/mcp:docs',
  name: 'docs',
  kind: 'mcp',
  target: 'docs-mcp',
  status: 'needs-auth',
  detail: 'Needs a sign in.',
  fix: 'sign-in',
  agent: 'codex',
};

/** A Codex adapter for these tests alone: found on PATH, with Codex's store and one row. */
function codexAdapter(bin: string | null): AgentAdapter {
  return {
    ...claudeCode,
    id: 'codex',
    name: 'Codex CLI',
    short: 'Codex',
    detect: async (): Promise<Detected> => {
      await Promise.resolve();
      return { bin, version: null };
    },
    config: {
      settingsFormat: 'toml',
      mcp: {
        ...codexMcp,
        list: async (): Promise<Connector[]> => {
          await Promise.resolve();
          return [DOCS];
        },
      },
    },
  };
}

function withCodex(bin: string | null): void {
  const codex = codexAdapter(bin);
  const real = agents.list();
  vi.spyOn(agents, 'list').mockReturnValue([...real, codex]);
  const get = agents.get.bind(agents);
  vi.spyOn(agents, 'get').mockImplementation((id) => (id === 'codex' ? codex : get(id)));
}

const SERVERS = {
  servers: [
    {
      server: {
        name: 'io.github.x/docs',
        title: 'Docs',
        packages: [
          {
            registryType: 'npm',
            identifier: 'docs-mcp',
            version: '1.0.0',
            transport: { type: 'stdio' },
          },
        ],
      },
    },
  ],
  metadata: {},
};

const fetchRegistry: FetchFunction = async () => {
  await Promise.resolve();
  return Response.json(SERVERS);
};

const answers: Responder = (call) => (call.args[0] === 'mcp' ? ok('') : undefined);

async function setup(): Promise<ReturnType<typeof makeApp>> {
  const env = await makeEnv();
  return makeApp(env, { responders: [answers], deps: { fetch: fetchRegistry } });
}

describe('connectors for an agent past Claude Code', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists its rows, offers it as a target and keeps them out of a Claude briefing', async () => {
    withCodex('/bin/codex');
    const test = await setup();
    const rt = test.app.runtime;
    await rt.caches.connectors.refresh();
    const state = buildConnectors(rt);
    expect(state.mcpAgents).toStrictEqual(['claude-code', 'codex']);
    expect(state.connectors.at(-1)).toStrictEqual(DOCS);
    expect(sessionBriefing(rt)).not.toContain('docs');
    expect(sessionBriefing(rt, 'codex')).toContain('- docs: needs sign in.');
    expect(sessionBriefing(rt, 'codex')).not.toContain('- Claude in Chrome');
  });

  it('leaves out an agent that is not installed', async () => {
    withCodex(null);
    const test = await setup();
    await test.app.runtime.caches.connectors.refresh();
    expect(buildConnectors(test.app.runtime).mcpAgents).toStrictEqual(['claude-code']);
  });

  it('adds a registry server through its own CLI and signs in with its own command', async () => {
    withCodex('/bin/codex');
    const test = await setup();
    const rt = test.app.runtime;
    await test.app.dispatch({ type: 'searchRegistry', query: 'docs' }, {});
    await test.app.dispatch(
      {
        type: 'installConnector',
        server: 'io.github.x/docs',
        option: 0,
        name: 'docs',
        values: {},
        agent: 'codex',
      },
      {},
    );
    const add = test.calls.find((call) => call.command === '/bin/codex');
    expect(add?.args).toStrictEqual(['mcp', 'add', 'docs', '--', 'npx', '-y', 'docs-mcp@1.0.0']);
    expect(buildConnectors(rt).registry.notice).toStrictEqual({
      ok: true,
      text: 'Added docs to Codex for every project. New sessions get it. Checking it now.',
    });
    await test.app.dispatch({ type: 'fixConnector', connectorId: DOCS.id }, {});
    expect(test.env.host.terminals.at(-1)).toMatchObject({
      command: '/bin/codex',
      args: ['mcp', 'login', 'docs'],
    });
  });

  it('says so when the agent has no MCP store or cannot be found', async () => {
    const test = await setup();
    const rt = test.app.runtime;
    await test.app.dispatch({ type: 'searchRegistry', query: 'docs' }, {});
    const install = async (agent: string): Promise<unknown> => {
      await test.app.dispatch(
        {
          type: 'installConnector',
          server: 'io.github.x/docs',
          option: 0,
          name: 'docs',
          values: {},
          agent,
        },
        {},
      );
      return buildConnectors(rt).registry.notice;
    };
    expect(await install('gemini')).toStrictEqual({
      ok: false,
      text: 'Overlord cannot manage MCP servers for gemini.',
    });
    withCodex(null);
    expect(await install('codex')).toStrictEqual({
      ok: false,
      text: 'Codex CLI is not installed.',
    });
  });

  it('adds a registry server to Copilot through copilot mcp add', async () => {
    vi.spyOn(copilot, 'detect').mockResolvedValue({ bin: '/bin/copilot', version: null });
    const test = await setup();
    const rt = test.app.runtime;
    await rt.caches.connectors.refresh();
    expect(buildConnectors(rt).mcpAgents).toContain('copilot');
    await test.app.dispatch({ type: 'searchRegistry', query: 'docs' }, {});
    await test.app.dispatch(
      {
        type: 'installConnector',
        server: 'io.github.x/docs',
        option: 0,
        name: 'docs',
        values: {},
        agent: 'copilot',
      },
      {},
    );
    const add = test.calls.find((call) => call.command === '/bin/copilot');
    expect(add?.args).toStrictEqual(['mcp', 'add', 'docs', '--', 'npx', '-y', 'docs-mcp@1.0.0']);
    expect(buildConnectors(rt).registry.notice).toStrictEqual({
      ok: true,
      text: 'Added docs to Copilot for every project. New sessions get it. Checking it now.',
    });
  });
});
