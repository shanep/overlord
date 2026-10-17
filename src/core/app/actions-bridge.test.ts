import { describe, expect, it } from 'vitest';

import { BRIDGE_BASE_URL } from '../bridge/boisestate.js';

import { makeApp, makeEnv } from './test-helpers/fixtures.js';

describe('newBridgeChat', () => {
  it('opens claude in a tab pointed at the bridge, with its tools but no MCP servers', async () => {
    const env = await makeEnv({ workspace: true });
    const asked: Readonly<Record<string, string>>[] = [];
    env.host.resolveBridgeEnv = async (launch): Promise<Record<string, string>> => {
      asked.push(launch);
      await Promise.resolve();
      return { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'tok' };
    };
    const { app } = makeApp(env);
    await app.dispatch({ type: 'newBridgeChat' }, {});
    expect(asked).toStrictEqual([{ ANTHROPIC_BASE_URL: BRIDGE_BASE_URL }]);
    const [terminal] = env.host.terminals;
    expect(env.host.terminals).toHaveLength(1);
    expect(terminal?.name).toBe('Boise State');
    expect(terminal?.command).toBe(env.host.settings.claudePath);
    expect(terminal?.cwd).toBe(env.host.workspace);
    expect(terminal?.env).toStrictEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      ANTHROPIC_AUTH_TOKEN: 'tok',
    });
    expect(terminal?.args.slice(0, 2)).toStrictEqual(['--session-id', terminal?.sessionId]);
    expect(terminal?.args).toContain('--strict-mcp-config');
    expect(terminal?.args).not.toContain('--tools');
  });

  it('starts in home when the window has no folder', async () => {
    const env = await makeEnv();
    env.host.resolveBridgeEnv = async (launch): Promise<Record<string, string>> => {
      await Promise.resolve();
      return { ...launch };
    };
    const { app } = makeApp(env);
    await app.dispatch({ type: 'newBridgeChat' }, {});
    expect(env.host.terminals[0]?.cwd).toBe(env.paths.home);
  });

  it('says why when the bridge cannot start, and opens nothing', async () => {
    const env = await makeEnv();
    env.host.resolveBridgeEnv = async (): Promise<Record<string, string>> => {
      await Promise.resolve();
      throw new Error('No Boise State API key is set.');
    };
    const { app } = makeApp(env);
    await app.dispatch({ type: 'newBridgeChat' }, {});
    expect(env.host.warnings).toStrictEqual(['No Boise State API key is set.']);
    expect(env.host.terminals).toStrictEqual([]);
  });

  it('says so when the host has no bridge', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'newBridgeChat' }, {});
    expect(env.host.infos).toStrictEqual([
      'The Boise State bridge is not available in this window.',
    ]);
    expect(env.host.terminals).toStrictEqual([]);
  });
});
