import { describe, expect, it } from 'vitest';

import { buildConfig } from './install.js';
import type { RegistryEntry } from './registry.js';
import {
  parseRegistry,
  REGISTRY_LIMIT,
  REGISTRY_URL,
  registryUrl,
  searchRegistry,
  suggestName,
} from './registry.js';

function meta(status = 'active'): Record<string, unknown> {
  return { 'io.modelcontextprotocol.registry/official': { status, isLatest: true } };
}

function reply(servers: readonly unknown[], nextCursor?: string): unknown {
  return {
    servers: servers.map((server) => ({ server, _meta: meta() })),
    metadata: nextCursor === undefined ? { count: servers.length } : { nextCursor },
  };
}

function only(value: unknown): RegistryEntry {
  const [entry] = parseRegistry(value).entries;
  if (entry === undefined) {
    throw new Error('no entry');
  }
  return entry;
}

function configOf(entry: RegistryEntry, values: Record<string, string>, index = 0): unknown {
  const option = entry.server.options[index];
  const plan = entry.plans[index];
  if (option === undefined || plan === undefined) {
    throw new Error('no option');
  }
  return buildConfig(plan, option.inputs, values);
}

const SENTRY = {
  name: 'io.github.getsentry/sentry-mcp',
  title: 'Sentry',
  description: 'Errors and traces.',
  version: '1.2.0',
  repository: { url: 'https://github.com/getsentry/sentry-mcp', source: 'github' },
  remotes: [{ type: 'streamable-http', url: 'https://mcp.sentry.dev/mcp' }],
  packages: [
    {
      registryType: 'npm',
      identifier: '@sentry/mcp-server',
      version: '1.2.0',
      transport: { type: 'stdio' },
      environmentVariables: [
        { name: 'SENTRY_TOKEN', isRequired: true, isSecret: true, description: 'Auth token' },
        { name: 'SENTRY_HOST', default: 'sentry.io' },
        { name: 'SENTRY_ORG' },
      ],
    },
  ],
};

describe('parseRegistry', () => {
  it('offers the remote and the package, with an input for each variable', () => {
    const entry = only(reply([SENTRY]));
    expect(entry.server).toStrictEqual({
      name: 'io.github.getsentry/sentry-mcp',
      title: 'Sentry',
      description: 'Errors and traces.',
      version: '1.2.0',
      repository: 'https://github.com/getsentry/sentry-mcp',
      suggestedName: 'sentry',
      options: [
        { kind: 'http', summary: 'https://mcp.sentry.dev/mcp', inputs: [] },
        {
          kind: 'npm',
          summary: 'npx -y @sentry/mcp-server@1.2.0',
          inputs: [
            {
              id: 'env:SENTRY_TOKEN',
              label: 'SENTRY_TOKEN',
              description: 'Auth token',
              required: true,
              secret: true,
              initial: '',
              placeholder: '',
            },
            {
              id: 'env:SENTRY_HOST',
              label: 'SENTRY_HOST',
              description: '',
              required: false,
              secret: false,
              initial: 'sentry.io',
              placeholder: '',
            },
            {
              id: 'env:SENTRY_ORG',
              label: 'SENTRY_ORG',
              description: '',
              required: false,
              secret: false,
              initial: '',
              placeholder: '',
            },
          ],
        },
      ],
    });
    expect(configOf(entry, {})).toStrictEqual({
      ok: true,
      config: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
    });
    expect(
      configOf(entry, { 'env:SENTRY_TOKEN': ' tok ', 'env:SENTRY_HOST': 'sentry.io' }, 1),
    ).toStrictEqual({
      ok: true,
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@sentry/mcp-server@1.2.0'],
        env: { SENTRY_TOKEN: 'tok', SENTRY_HOST: 'sentry.io' },
      },
    });
    expect(configOf(entry, {}, 1)).toStrictEqual({
      ok: false,
      error: 'Fill in SENTRY_TOKEN first.',
    });
  });

  it('fills URL variables and header templates', () => {
    const entry = only(
      reply([
        {
          name: 'com.example/notes',
          remotes: [
            {
              type: 'sse',
              url: 'https://notes.example/{space}/sse',
              variables: { space: { description: 'Your space', isRequired: true } },
              headers: [
                {
                  name: 'Authorization',
                  value: 'Bearer {api_key}',
                  isRequired: true,
                  isSecret: true,
                  description: 'API key',
                },
                { name: 'X-Team', description: 'Team id' },
              ],
            },
          ],
        },
      ]),
    );
    const [option] = entry.server.options;
    expect(option?.summary).toBe('https://notes.example/{space}/sse');
    expect(option?.inputs.map((input) => [input.id, input.required, input.secret])).toStrictEqual([
      ['var:space', true, false],
      ['var:api_key', true, true],
      ['header:X-Team', false, false],
    ]);
    expect(configOf(entry, { 'var:space': 'mine', 'var:api_key': 'k1' })).toStrictEqual({
      ok: true,
      config: {
        type: 'sse',
        url: 'https://notes.example/mine/sse',
        headers: { Authorization: 'Bearer k1' },
      },
    });
  });

  it('runs PyPI with uvx and Docker with run -i --rm and -e for each variable', () => {
    const entry = only(
      reply([
        {
          name: 'io.github.someone/db-tools',
          version: '0.3.0',
          packages: [
            {
              registryType: 'pypi',
              identifier: 'db-tools',
              version: '0.3.0',
              runtimeHint: 'uvx',
              transport: { type: 'stdio' },
              packageArguments: [
                { type: 'positional', valueHint: 'database', isRequired: true },
                { type: 'named', name: '--read-only' },
                { type: 'named', name: '--pool', default: '4' },
                { type: 'named', name: '--schema', value: '{schema}' },
              ],
            },
            {
              registryType: 'oci',
              identifier: 'ghcr.io/someone/db-tools:0.3.0',
              runtimeHint: 'docker',
              transport: { type: 'stdio' },
              runtimeArguments: [
                { type: 'positional', value: 'run' },
                { type: 'positional', value: '-i' },
                { type: 'named', name: '-v', value: '{data}:/data' },
              ],
              environmentVariables: [
                { name: 'DB_URL', isRequired: true, isSecret: true },
                { name: 'DB_LOG' },
              ],
            },
          ],
        },
      ]),
    );
    expect(entry.server.options.map((option) => option.summary)).toStrictEqual([
      'uvx db-tools==0.3.0 {database} --read-only --schema {schema}',
      'docker run --rm -e DB_URL={DB_URL} -e DB_LOG={DB_LOG} -i -v {data}:/data ghcr.io/someone/db-tools:0.3.0',
    ]);
    expect(configOf(entry, { 'arg:database': 'prod' })).toStrictEqual({
      ok: true,
      config: {
        type: 'stdio',
        command: 'uvx',
        args: ['db-tools==0.3.0', 'prod', '--read-only'],
      },
    });
    expect(configOf(entry, { 'env:DB_URL': 'pg://x', 'var:data': '/srv' }, 1)).toStrictEqual({
      ok: true,
      config: {
        type: 'stdio',
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-e',
          'DB_URL=pg://x',
          '-i',
          '-v',
          '/srv:/data',
          'ghcr.io/someone/db-tools:0.3.0',
        ],
      },
    });
  });

  it('leaves out what Claude Code cannot start and servers that are not active', () => {
    const page = parseRegistry({
      servers: [
        {
          server: {
            name: 'io.github.a/bundle',
            packages: [
              {
                registryType: 'mcpb',
                identifier: 'https://x/a.mcpb',
                transport: { type: 'stdio' },
              },
              {
                registryType: 'npm',
                identifier: 'a-local',
                transport: { type: 'streamable-http', url: 'http://localhost:3000/mcp' },
              },
              {
                registryType: 'pypi',
                identifier: 'a-py',
                runtimeHint: 'pipx',
                transport: { type: 'stdio' },
              },
              'not a package',
            ],
            remotes: [{ type: 'websocket', url: 'wss://a' }],
          },
          _meta: meta(),
        },
        { server: { name: 'io.github.b/old' }, _meta: meta('deprecated') },
        { server: { name: 'io.github.a/bundle' }, _meta: meta() },
        { server: { name: 'io.github.c/plain' } },
      ],
      metadata: { nextCursor: 'io.github.c/plain:1.0.0' },
    });
    expect(page.more).toBe(true);
    expect(
      page.entries.map((entry) => [entry.server.name, entry.server.options.length]),
    ).toStrictEqual([
      ['io.github.a/bundle', 0],
      ['io.github.c/plain', 0],
    ]);
    expect(page.entries[1]?.server).toMatchObject({ title: 'io.github.c/plain', repository: null });
  });

  it('keeps -y for npm when the registry already passes it, and names a package without a version', () => {
    const entry = only(
      reply([
        {
          name: 'io.github.x/thing',
          packages: [
            {
              registryType: 'npm',
              identifier: 'thing',
              runtimeHint: 'npx',
              transport: { type: 'stdio' },
              runtimeArguments: [{ type: 'named', name: '--yes' }],
            },
          ],
        },
      ]),
    );
    expect(entry.server.options[0]?.summary).toBe('npx --yes thing');
  });

  it('says so when the reply is not a server list', () => {
    expect(() => parseRegistry({ nope: true })).toThrow(
      'The MCP registry sent a reply Overlord could not read.',
    );
  });
});

describe('suggestName', () => {
  it.each([
    ['io.github.getsentry/sentry-mcp', 'sentry'],
    ['io.github.modelcontextprotocol/server-filesystem', 'filesystem'],
    ['com.example/mcp-server-postgres', 'postgres'],
    ['ai.2kw/mcp-server', '2kw'],
    ['ac.inference.sh/mcp', 'inference'],
    ['io.github.someone/My Tool!', 'my-tool'],
    ['io.github/mcp', 'server'],
  ])('%s becomes %s', (name, expected) => {
    expect(suggestName(name)).toBe(expected);
  });
});

describe('searchRegistry', () => {
  it('asks for the latest version of each match', async () => {
    const urls: string[] = [];
    const page = await searchRegistry(async (url) => {
      urls.push(url);
      await Promise.resolve();
      return Response.json(reply([SENTRY]));
    }, ' sentry ');
    expect(urls).toStrictEqual([
      `${REGISTRY_URL}?limit=${String(REGISTRY_LIMIT)}&version=latest&search=sentry`,
    ]);
    expect(page.entries).toHaveLength(1);
    expect(registryUrl('')).toBe(`${REGISTRY_URL}?limit=${String(REGISTRY_LIMIT)}&version=latest`);
  });

  it('fails with the status when the registry says no', async () => {
    await expect(
      searchRegistry(async () => {
        await Promise.resolve();
        return new Response('down', { status: 503 });
      }, 'x'),
    ).rejects.toThrow('The MCP registry answered 503.');
  });
});
