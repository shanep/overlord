import { connect } from 'node:net';

import { describe, expect, it } from 'vitest';

import { EMPTY_REGISTRY } from '../../../shared/connectors.js';
import { installHooks } from '../../hooks/install.js';
import { encodeMessage } from '../../hooks/protocol.js';
import { CHROME_ATTACH_MS } from '../actions-connectors.js';
import type { Responder, TestApp } from '../test-helpers/fixtures.js';
import { makeApp, makeEnv, NOW, ok, shortSocketPath, waitFor } from '../test-helpers/fixtures.js';

import { EMPTY_CONNECTORS } from './connectors-data.js';
import { buildConnectors, sessionBriefing } from './connectors.js';

const LIST = [
  'Checking MCP server health…',
  '',
  'claude.ai Gmail: https://gmail - ✔ Connected',
  'sentry: https://sentry - ⚠ Needs authentication',
].join('\n');

const mcpList: Responder = (call) =>
  call.args[0] === 'mcp' && call.args[1] === 'list' ? ok(LIST) : undefined;

const startsChrome: Responder = (call) =>
  call.command === 'sh' || call.command === 'open' ? ok() : undefined;

interface Setup {
  readonly test: TestApp;
  readonly delays: number[];
  readonly browsers: { value: string };
}

async function setup(
  workspace = false,
  responders: readonly Responder[] = [mcpList],
): Promise<Setup> {
  const env = await makeEnv({ workspace });
  const delays: number[] = [];
  const browsers = { value: '[]' };
  const test = makeApp(env, {
    responders,
    deps: {
      delay: async (ms: number): Promise<void> => {
        delays.push(ms);
        await Promise.resolve();
      },
      callTool: async (): Promise<string> => {
        await Promise.resolve();
        return browsers.value;
      },
    },
  });
  return { test, delays, browsers };
}

describe('the Connectors view', () => {
  it('starts empty, checks in the background and shows every connector', async () => {
    const { test } = await setup();
    const rt = test.app.runtime;
    expect(buildConnectors(rt)).toStrictEqual({
      ...EMPTY_CONNECTORS,
      checking: true,
      registry: EMPTY_REGISTRY,
    });
    await waitFor(() => rt.caches.connectors.peek().checkedAt !== null);
    const state = buildConnectors(rt);
    expect(state.checking).toBe(false);
    expect(state.checkedAt).toBe(NOW);
    expect(state.folder).toBeNull();
    expect(state.connectors.map((connector) => [connector.name, connector.status])).toStrictEqual([
      ['Claude in Chrome', 'missing'],
      ['Headless Chrome', expect.any(String)],
      ['claude.ai Gmail', 'ok'],
      ['sentry', 'needs-auth'],
    ]);
    const list = test.calls.find((call) => call.args[0] === 'mcp');
    expect(list?.options.cwd).toBe(rt.paths.home);
    expect(test.app.stateFor('connectors', {})).toStrictEqual({
      type: 'state',
      view: 'connectors',
      state,
    });
  });

  it('runs claude mcp list in the workspace, so project servers count', async () => {
    const { test } = await setup(true);
    const rt = test.app.runtime;
    await rt.caches.connectors.refresh();
    expect(buildConnectors(rt).folder).toBe(rt.host.workspaceFolder());
    expect(test.calls.find((call) => call.args[0] === 'mcp')?.options.cwd).toBe(
      rt.host.workspaceFolder(),
    );
  });

  it('rechecks on request and on a full refresh', async () => {
    const { test, browsers } = await setup();
    const rt = test.app.runtime;
    await rt.caches.connectors.refresh();
    browsers.value = '[{"displayName":"Mac"}]';
    let notified = 0;
    test.app.onChange(() => {
      notified += 1;
    });
    await test.app.dispatch({ type: 'recheckConnectors' }, {});
    expect(notified).toBeGreaterThan(0);
    expect(buildConnectors(rt).connectors[0]?.status).toBe('ok');
    const before = test.calls.length;
    await test.app.refresh();
    expect(test.calls.slice(before).some((call) => call.args[0] === 'mcp')).toBe(true);
  });
});

describe('fixing a connector', () => {
  it('signs in to a connector in a terminal', async () => {
    const { test } = await setup();
    const rt = test.app.runtime;
    const host = test.env.host;
    await rt.caches.connectors.refresh();
    await test.app.dispatch({ type: 'fixConnector', connectorId: 'mcp:sentry' }, {});
    expect(host.terminals).toStrictEqual([
      {
        name: 'Sign in: sentry',
        command: 'claude',
        args: ['mcp', 'login', 'sentry'],
        cwd: rt.paths.home,
        sessionId: null,
      },
    ]);
    expect(host.infos).toStrictEqual([
      'Finish signing in to sentry in the terminal, then press Recheck.',
    ]);
  });

  it('opens Chrome on Linux, waits for the extension and checks again', async () => {
    const { test, delays, browsers } = await setup(false, [mcpList, startsChrome]);
    const rt = test.app.runtime;
    await rt.caches.connectors.refresh();
    browsers.value = '[{"displayName":"Mac"}]';
    await test.app.dispatch({ type: 'fixConnector', connectorId: 'chrome:claude-in-chrome' }, {});
    const opened = test.calls.find((call) => call.command === 'sh');
    expect(opened?.args[1]).toContain('google-chrome');
    expect(delays).toStrictEqual([CHROME_ATTACH_MS]);
    expect(buildConnectors(rt).connectors[0]?.status).toBe('ok');
  });

  it('opens Chrome with open on macOS', async () => {
    const env = await makeEnv();
    const test = makeApp(env, {
      responders: [mcpList, startsChrome],
      deps: {
        platform: 'darwin',
        delay: async (): Promise<void> => {
          await Promise.resolve();
        },
      },
    });
    await test.app.runtime.caches.connectors.refresh();
    await test.app.dispatch({ type: 'fixConnector', connectorId: 'chrome:claude-in-chrome' }, {});
    expect(test.calls.find((call) => call.command === 'open')?.args).toStrictEqual([
      '-a',
      'Google Chrome',
    ]);
  });

  it('says so when Chrome cannot be opened or there is nothing to fix', async () => {
    const { test, delays } = await setup();
    const rt = test.app.runtime;
    await rt.caches.connectors.refresh();
    await test.app.dispatch({ type: 'fixConnector', connectorId: 'chrome:claude-in-chrome' }, {});
    await test.app.dispatch({ type: 'fixConnector', connectorId: 'claude.ai:claude.ai Gmail' }, {});
    await test.app.dispatch({ type: 'fixConnector', connectorId: 'gone' }, {});
    expect(delays).toStrictEqual([]);
    expect(test.env.host.errors).toStrictEqual([
      'Could not find Chrome to open. Start it yourself, then press Recheck.',
      'There is nothing Overlord can fix for claude.ai:claude.ai Gmail.',
      'There is nothing Overlord can fix for gone.',
    ]);
  });
});

describe('sessionBriefing', () => {
  it('gives the rule at once and the statuses after the first check', async () => {
    const { test } = await setup();
    const rt = test.app.runtime;
    expect(sessionBriefing(rt)).toMatch(/^Overlord connector check\. Before you start a plan/u);
    await waitFor(() => rt.caches.connectors.peek().checkedAt !== null);
    const text = sessionBriefing(rt);
    expect(text).toContain('- sentry: needs sign in.');
    expect(text).toContain('- claude.ai Gmail: ready');
  });
});

/** Sends one SessionStart through the hook socket and returns the output Overlord answers with. */
async function sessionStart(socket: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = connect(socket);
    let text = '';
    client.setEncoding('utf8');
    client.on('error', reject);
    client.on('data', (chunk: string) => {
      text += chunk;
      if (text.endsWith('\n')) {
        client.destroy();
        const reply: unknown = JSON.parse(text);
        resolve(
          typeof reply === 'object' && reply !== null && 'output' in reply ? reply.output : null,
        );
      }
    });
    client.write(
      encodeMessage({
        id: 'm1',
        event: {
          session_id: 's1',
          cwd: '/w',
          transcript_path: '/t.jsonl',
          hook_event_name: 'SessionStart',
          source: 'startup',
        },
      }),
    );
  });
}

/** Starts an app that owns the hook socket, with one connector check done. */
async function startWith(briefSessions: boolean): Promise<string> {
  const env = await makeEnv({ settings: { briefSessions } });
  await installHooks({
    settingsFile: env.paths.userSettings,
    hookCommand: 'node "/ext/dist/overlord-hook.cjs"',
  });
  const socket = shortSocketPath();
  const test = makeApp(env, { responders: [mcpList], deps: { hookSocketPath: socket } });
  await test.app.start();
  await test.app.runtime.caches.connectors.refresh();
  return socket;
}

describe('the SessionStart hook', () => {
  it('tells a new session which connectors are ready', async () => {
    const output = await sessionStart(await startWith(true));
    expect(output).toMatchObject({ hookSpecificOutput: { hookEventName: 'SessionStart' } });
    expect(JSON.stringify(output)).toContain('- sentry: needs sign in.');
  });

  it('stays quiet when the setting is off', async () => {
    expect(await sessionStart(await startWith(false))).toStrictEqual({});
  });
});
