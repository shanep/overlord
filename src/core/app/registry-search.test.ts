import { describe, expect, it } from 'vitest';

import { EMPTY_REGISTRY } from '../../shared/connectors.js';
import type { FetchFunction } from '../sync/github.js';

import type { Runtime } from './runtime.js';
import type { Responder, TestApp } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, ok, waitFor } from './test-helpers/fixtures.js';
import { buildConnectors } from './views/connectors.js';

const SERVERS = [
  {
    name: 'io.github.getsentry/sentry-mcp',
    title: 'Sentry',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.sentry.dev/mcp' }],
    packages: [
      {
        registryType: 'npm',
        identifier: '@sentry/mcp-server',
        version: '1.2.0',
        transport: { type: 'stdio' },
        environmentVariables: [{ name: 'SENTRY_TOKEN', isRequired: true, isSecret: true }],
      },
    ],
  },
];

function registry(answer: () => Response): { fetch: FetchFunction; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url): Promise<Response> => {
      urls.push(url);
      await Promise.resolve();
      return answer();
    },
  };
}

function found(): Response {
  return Response.json({ servers: SERVERS.map((server) => ({ server })), metadata: {} });
}

const mcpList: Responder = (call) =>
  call.args[0] === 'mcp' && call.args[1] === 'list' ? ok('') : undefined;

const adds: Responder = (call) =>
  call.args[0] === 'mcp' && call.args[1] === 'add-json' ? ok('Added') : undefined;

const refuses: Responder = (call) =>
  call.args[0] === 'mcp' && call.args[1] === 'add-json'
    ? { code: 1, stdout: '', stderr: 'MCP server sentry already exists in user config\n' }
    : undefined;

interface Setup {
  readonly test: TestApp;
  readonly urls: string[];
  readonly rt: Runtime;
}

async function setup(
  responders: readonly Responder[],
  answer: () => Response = found,
): Promise<Setup> {
  const env = await makeEnv();
  const { fetch, urls } = registry(answer);
  const test = makeApp(env, { responders, deps: { fetch } });
  return { test, urls, rt: test.app.runtime };
}

describe('the registry search', () => {
  it('browses the whole registry when the view first opens, then searches', async () => {
    const { test, urls, rt } = await setup([mcpList]);
    expect(buildConnectors(rt).registry).toStrictEqual({
      ...EMPTY_REGISTRY,
      query: '',
      searching: true,
    });
    await waitFor(() => !buildConnectors(rt).registry.searching);
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain('search=');
    expect(buildConnectors(rt).registry.results).toHaveLength(1);
    await test.app.dispatch({ type: 'searchRegistry', query: 'sentry' }, {});
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('search=sentry');
    const state = buildConnectors(rt).registry;
    expect(state).toMatchObject({ query: 'sentry', searching: false, error: null, more: false });
    expect(state.results.map((server) => [server.name, server.options.length])).toStrictEqual([
      ['io.github.getsentry/sentry-mcp', 2],
    ]);
  });

  it('says why a search failed and clears the old results', async () => {
    let up = true;
    const { test, rt } = await setup([mcpList], () =>
      up ? found() : new Response('', { status: 500 }),
    );
    await test.app.dispatch({ type: 'searchRegistry', query: 'sentry' }, {});
    up = false;
    await test.app.dispatch({ type: 'searchRegistry', query: 'sentry' }, {});
    expect(buildConnectors(rt).registry).toMatchObject({
      results: [],
      searching: false,
      error: 'Could not search the MCP registry: The MCP registry answered 500.',
    });
  });

  it('drops a search that finishes after a newer one started', async () => {
    const env = await makeEnv();
    const waits: (() => void)[] = [];
    const fetch: FetchFunction = async (url) => {
      await new Promise<void>((resolve) => {
        waits.push(resolve);
      });
      return url.includes('search=old')
        ? Response.json({ servers: [{ server: { name: 'io.github.x/old' } }] })
        : found();
    };
    const test = makeApp(env, { responders: [mcpList], deps: { fetch } });
    const first = test.app.dispatch({ type: 'searchRegistry', query: 'old' }, {});
    const second = test.app.dispatch({ type: 'searchRegistry', query: 'new' }, {});
    await Promise.resolve();
    await Promise.resolve();
    for (const resolve of waits.toReversed()) {
      resolve();
      await Promise.resolve();
    }
    await Promise.all([first, second]);
    const state = buildConnectors(test.app.runtime).registry;
    expect(state.query).toBe('new');
    expect(state.results.map((server) => server.name)).toStrictEqual([
      'io.github.getsentry/sentry-mcp',
    ]);
  });
});

function listed(name: string): Record<string, unknown> {
  return { name, repository: { url: `https://github.com/${name}` } };
}

/** Two pages: a and b, then b again and c, so the repeat is dropped. */
function pages(fail: { value: boolean }): () => Response {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls > 1 && fail.value) {
      return new Response('', { status: 502 });
    }
    return calls === 1
      ? Response.json({
          servers: [{ server: listed('io.github.x/a') }, { server: listed('io.github.x/b') }],
          metadata: { nextCursor: 'io.github.x/b:1.0.0' },
        })
      : Response.json({
          servers: [{ server: listed('io.github.x/b') }, { server: listed('io.github.x/c') }],
          metadata: {},
        });
  };
}

describe('browsing the registry', () => {
  it('pages through every server, keeping what it already has', async () => {
    const { test, urls, rt } = await setup([mcpList], pages({ value: false }));
    await test.app.dispatch({ type: 'moreRegistry' }, {});
    expect(urls).toStrictEqual([]);
    await test.app.dispatch({ type: 'searchRegistry', query: '' }, {});
    expect(buildConnectors(rt).registry.more).toBe(true);
    await test.app.dispatch({ type: 'moreRegistry' }, {});
    expect(urls[1]).toContain('cursor=io.github.x%2Fb%3A1.0.0');
    expect(urls[1]).not.toContain('search=');
    const state = buildConnectors(rt).registry;
    expect(state.results.map((entry) => entry.name)).toStrictEqual([
      'io.github.x/a',
      'io.github.x/b',
      'io.github.x/c',
    ]);
    expect(state).toMatchObject({ more: false, loadingMore: false, error: null });
    await test.app.dispatch({ type: 'moreRegistry' }, {});
    expect(urls).toHaveLength(2);
  });

  it('keeps the results it has when the next page fails', async () => {
    const { test, rt } = await setup([mcpList], pages({ value: true }));
    await test.app.dispatch({ type: 'searchRegistry', query: '' }, {});
    await test.app.dispatch({ type: 'moreRegistry' }, {});
    expect(buildConnectors(rt).registry).toMatchObject({
      more: true,
      loadingMore: false,
      error: 'Could not load more from the MCP registry: The MCP registry answered 502.',
    });
    expect(buildConnectors(rt).registry.results).toHaveLength(2);
  });

  it('opens a repository the registry listed and nothing else', async () => {
    const { test } = await setup([mcpList], pages({ value: false }));
    await test.app.dispatch({ type: 'searchRegistry', query: '' }, {});
    for (const url of ['https://github.com/io.github.x/a', 'https://evil.example', 'file:///etc']) {
      await test.app.dispatch({ type: 'openRegistryLink', url }, {});
    }
    expect(test.env.host.external).toStrictEqual(['https://github.com/io.github.x/a']);
  });
});

describe('installing a server from the registry', () => {
  it('adds it to user scope with add-json, then checks the connectors again', async () => {
    const { test, rt } = await setup([mcpList, adds]);
    await test.app.dispatch({ type: 'searchRegistry', query: 'sentry' }, {});
    const before = test.calls.length;
    await test.app.dispatch(
      {
        type: 'installConnector',
        server: 'io.github.getsentry/sentry-mcp',
        option: 1,
        name: ' sentry ',
        values: { 'env:SENTRY_TOKEN': 'tok' },
      },
      {},
    );
    const calls = test.calls.slice(before);
    const add = calls.find((call) => call.args[1] === 'add-json');
    expect(add?.command).toBe('claude');
    expect(add?.args).toStrictEqual([
      'mcp',
      'add-json',
      '--scope',
      'user',
      'sentry',
      JSON.stringify({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@sentry/mcp-server@1.2.0'],
        env: { SENTRY_TOKEN: 'tok' },
      }),
    ]);
    expect(add?.options.cwd).toBe(rt.paths.home);
    expect(calls.some((call) => call.args[1] === 'list')).toBe(true);
    expect(buildConnectors(rt).registry).toMatchObject({
      installing: null,
      notice: {
        ok: true,
        text: 'Added sentry for every project. New sessions get it. Checking it now.',
      },
    });
  });

  it('shows what went wrong instead of adding it', async () => {
    const { test, rt } = await setup([mcpList, refuses]);
    const install = async (
      server: string,
      name: string,
      values: Record<string, string> = {},
    ): Promise<unknown> => {
      await test.app.dispatch({ type: 'installConnector', server, option: 1, name, values }, {});
      return buildConnectors(rt).registry.notice;
    };
    expect(await install('io.github.getsentry/sentry-mcp', 'sentry')).toStrictEqual({
      ok: false,
      text: 'io.github.getsentry/sentry-mcp is not in the search results any more. Search again.',
    });
    await test.app.dispatch({ type: 'searchRegistry', query: 'sentry' }, {});
    expect(await install('io.github.getsentry/sentry-mcp', 'no spaces')).toStrictEqual({
      ok: false,
      text: 'A name can use only letters, digits, dashes and underscores.',
    });
    expect(await install('io.github.getsentry/sentry-mcp', 'sentry')).toStrictEqual({
      ok: false,
      text: 'Fill in SENTRY_TOKEN first.',
    });
    expect(
      await install('io.github.getsentry/sentry-mcp', 'sentry', { 'env:SENTRY_TOKEN': 'tok' }),
    ).toStrictEqual({
      ok: false,
      text: 'claude mcp add-json failed: MCP server sentry already exists in user config',
    });
    expect(buildConnectors(rt).registry.installing).toBeNull();
  });
});
