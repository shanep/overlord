import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveClaudePaths } from '../../paths.js';
import type { Exec } from '../../sync/exec.js';
import { createNodeExec } from '../../sync/exec.js';
import type { McpPlace } from '../types.js';

import { addArgs, codexMcp } from './mcp.js';
import { codexHome } from './observer.js';

const FAKE_CODEX = fileURLToPath(
  new URL('../../../../test/fake-agents/codex/fake-codex-mcp.mjs', import.meta.url),
);

/** Runs the fake the way the store would run codex, through node since it is a script. */
const nodeExec = createNodeExec();
const runFake: Exec = async (command, args, options) =>
  nodeExec(process.execPath, [command, ...args], options);

const USER_TOML = `# my servers
model = "gpt-5"

[mcp_servers.docs]
command = "npx"
args = ["-y", "@acme/docs-mcp"]

[mcp_servers.docs.env]
TOKEN = "x"

[mcp_servers."linear"]
url = "https://mcp.linear.app/mcp"
enabled = false
`;

describe('the Codex MCP store', () => {
  let home: string;
  let codex: string;
  let work: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ovl-codex-mcp-')));
    codex = path.join(home, 'codex-home');
    work = path.join(home, 'work');
    await mkdir(codex, { recursive: true });
    await mkdir(path.join(work, '.codex'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function place(cwd: string | null = work): McpPlace {
    return {
      home,
      env: { CODEX_HOME: codex },
      claude: resolveClaudePaths({ home, platform: 'linux', env: {} }),
      cwd,
    };
  }

  it('finds CODEX_HOME, or ~/.codex without it', () => {
    expect(codexHome({ home: '/h', env: { CODEX_HOME: '/c' } })).toBe('/c');
    expect(codexHome({ home: '/h', env: { CODEX_HOME: '' } })).toBe(path.join('/h', '.codex'));
    expect(codexHome({ home: '/h', env: {} })).toBe(path.join('/h', '.codex'));
  });

  it('reads [mcp_servers] from the user and project config.toml', async () => {
    await writeFile(path.join(codex, 'config.toml'), USER_TOML);
    await writeFile(
      path.join(work, '.codex', 'config.toml'),
      '[mcp_servers.docs]\ncommand = "docs-local"\n',
    );
    const user = path.join(codex, 'config.toml');
    const project = path.join(work, '.codex', 'config.toml');
    expect(await codexMcp.read(place())).toStrictEqual({
      servers: [
        {
          name: 'docs',
          scope: 'project',
          file: project,
          transport: 'stdio',
          target: 'docs-local',
          state: 'on',
        },
        {
          name: 'docs',
          scope: 'user',
          file: user,
          transport: 'stdio',
          target: 'npx -y @acme/docs-mcp',
          state: 'on',
        },
        {
          name: 'linear',
          scope: 'user',
          file: user,
          transport: 'http',
          target: 'https://mcp.linear.app/mcp',
          state: 'off',
        },
      ],
      errors: [],
    });
    const userOnly = await codexMcp.read(place(null));
    expect(userOnly.servers.map((server) => server.scope)).toStrictEqual(['user', 'user']);
  });

  it('lists each name once as a Codex row, and says when a file will not parse', async () => {
    await writeFile(path.join(codex, 'config.toml'), USER_TOML);
    await writeFile(path.join(work, '.codex', 'config.toml'), '[mcp_servers.docs\n');
    const rows = await codexMcp.list({
      exec: runFake,
      cli: { bin: FAKE_CODEX, env: {} },
      cwd: work,
      place: place(),
    });
    expect(rows.map((row) => [row.id, row.status, row.agent])).toStrictEqual([
      ['codex/mcp:docs', 'unchecked', 'codex'],
      ['codex/mcp:linear', 'disabled', 'codex'],
      ['codex/mcp:files', 'failed', 'codex'],
    ]);
    expect(rows[0]?.detail).toBe(
      `Set up in ${path.join(codex, 'config.toml')}. Codex does not report whether it connects, so Overlord does not check it.`,
    );
    expect(rows[2]?.detail).toContain(path.join(work, '.codex', 'config.toml'));
  });

  it('reads nothing from a config.toml without servers or with none at all', async () => {
    expect(await codexMcp.read(place())).toStrictEqual({ servers: [], errors: [] });
    await writeFile(path.join(codex, 'config.toml'), 'mcp_servers = 1\n');
    expect(await codexMcp.read(place())).toStrictEqual({ servers: [], errors: [] });
  });

  it('builds codex mcp add args, and refuses what that command cannot set', () => {
    expect(
      addArgs('docs', { type: 'stdio', command: 'npx', args: ['-y', 'd'], env: { A: '1' } }),
    ).toStrictEqual({ args: ['mcp', 'add', '--env', 'A=1', 'docs', '--', 'npx', '-y', 'd'] });
    expect(addArgs('lin', { type: 'http', url: 'https://l' })).toStrictEqual({
      args: ['mcp', 'add', 'lin', '--url', 'https://l'],
    });
    expect(addArgs('s', { type: 'sse', url: 'https://s' })).toStrictEqual({
      error: 'Codex connects to remote servers over streamable HTTP only, not SSE.',
    });
    expect(addArgs('h', { type: 'http', url: 'https://h', headers: { A: 'b' } })).toStrictEqual({
      error:
        'codex mcp add cannot set headers. Add the server to ~/.codex/config.toml with http_headers yourself.',
    });
  });

  describe('through a fake codex', () => {
    let log: string;

    beforeEach(() => {
      log = path.join(home, 'argv.jsonl');
    });

    async function argv(): Promise<unknown[]> {
      const text = await readFile(log, 'utf8');
      return text
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line));
    }

    function write(env: Record<string, string> = {}): Parameters<typeof codexMcp.add>[0] {
      return {
        exec: runFake,
        cli: { bin: FAKE_CODEX, env: { FAKE_CODEX_ARGV: log, ...env } },
        cwd: home,
        name: 'docs',
        server: { type: 'stdio', command: 'npx', args: ['-y', '@acme/docs-mcp'] },
        scope: 'user',
      };
    }

    it('adds and removes through codex mcp, never by writing config.toml', async () => {
      expect(await codexMcp.add(write())).toStrictEqual({ ok: true });
      expect(await codexMcp.remove({ ...write(), name: 'docs' })).toStrictEqual({ ok: true });
      expect(await argv()).toStrictEqual([
        ['mcp', 'add', 'docs', '--', 'npx', '-y', '@acme/docs-mcp'],
        ['mcp', 'remove', 'docs'],
      ]);
    });

    it('says what codex printed when it fails, and refuses other scopes without running it', async () => {
      expect(
        await codexMcp.add(write({ FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'bad name' })),
      ).toStrictEqual({ ok: false, error: 'codex mcp add failed: bad name' });
      expect(await codexMcp.remove({ ...write(), scope: 'project' })).toStrictEqual({
        ok: false,
        error: 'Codex adds and removes servers in the user config.toml only.',
      });
      expect(
        await codexMcp.add({ ...write(), server: { type: 'sse', url: 'https://s' } }),
      ).toMatchObject({ ok: false });
      expect(await argv()).toHaveLength(1);
    });
  });

  it('signs in with codex mcp login', () => {
    expect(codexMcp.signInArgs?.('docs')).toStrictEqual(['mcp', 'login', 'docs']);
    expect(codexMcp.scopes).toStrictEqual(['user']);
  });
});
