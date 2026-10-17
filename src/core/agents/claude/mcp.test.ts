// cspell:words Mcpjson
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseMcpList } from '../../connectors/mcp-list.js';
import type { ClaudePaths } from '../../paths.js';
import { resolveClaudePaths } from '../../paths.js';
import type { Exec, ExecOptions } from '../../sync/exec.js';
import type { McpPlace } from '../types.js';

import { claudeMcp, MCP_LIST_TIMEOUT_MS } from './mcp.js';

const LIST = [
  'Checking MCP server health…',
  '',
  'claude.ai Gmail: https://gmail - ✔ Connected',
  'sentry: https://mcp.sentry.dev/mcp (HTTP) - ⚠ Needs authentication',
  'docs: npx -y docs-mcp - ✔ Connected',
].join('\n');

describe("Claude Code's MCP store", () => {
  let home: string;
  let work: string;
  let paths: ClaudePaths;
  let calls: { command: string; args: readonly string[]; options: ExecOptions }[];

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ovl-claude-mcp-')));
    work = path.join(home, 'work');
    await mkdir(path.join(work, '.claude'), { recursive: true });
    await mkdir(path.join(home, '.claude'), { recursive: true });
    paths = resolveClaudePaths({ home, platform: 'linux', env: {} });
    calls = [];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function place(cwd: string | null = work): McpPlace {
    return { home, env: {}, claude: paths, cwd };
  }

  function answering(code: number, stdout: string, stderr = ''): Exec {
    return async (command, args, options) => {
      await Promise.resolve();
      calls.push({ command, args, options });
      return { code, stdout, stderr };
    };
  }

  async function files(): Promise<void> {
    await writeFile(
      paths.claudeJson,
      JSON.stringify({
        mcpServers: { docs: { type: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'] } },
        projects: {
          [work]: {
            mcpServers: { docs: { command: 'docs-local' } },
            enabledMcpjsonServers: ['sentry'],
            disabledMcpjsonServers: ['old'],
          },
        },
      }),
    );
    await writeFile(
      path.join(work, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
          old: { type: 'sse', url: 'https://old' },
          fresh: { command: 'fresh-mcp' },
        },
      }),
    );
  }

  it('reads user and local servers from ~/.claude.json and project ones with their approvals', async () => {
    await files();
    const read = await claudeMcp.read(place());
    expect(read.errors).toStrictEqual([]);
    expect(
      read.servers.map((server) => [server.name, server.scope, server.state, server.target]),
    ).toStrictEqual([
      ['docs', 'local', 'on', 'docs-local'],
      ['sentry', 'project', 'on', 'https://mcp.sentry.dev/mcp'],
      ['old', 'project', 'off', 'https://old'],
      ['fresh', 'project', 'pending', 'fresh-mcp'],
      ['docs', 'user', 'on', 'npx -y docs-mcp'],
    ]);
    const userOnly = await claudeMcp.read(place(null));
    expect(userOnly.servers.map((server) => server.scope)).toStrictEqual(['user']);
  });

  it('approves every project server when a settings file says so', async () => {
    await files();
    await writeFile(
      path.join(work, '.claude', 'settings.local.json'),
      '{"enableAllProjectMcpServers":true}',
    );
    const approved = await claudeMcp.read(place());
    expect(approved.servers.map((server) => server.state)).toStrictEqual([
      'on',
      'on',
      'off',
      'on',
      'on',
    ]);
  });

  it('says which file would not parse, and reads nothing when there are none', async () => {
    expect(await claudeMcp.read(place())).toStrictEqual({ servers: [], errors: [] });
    await writeFile(paths.claudeJson, '{');
    await writeFile(path.join(work, '.mcp.json'), '{');
    const read = await claudeMcp.read(place());
    expect(read.servers).toStrictEqual([]);
    expect(read.errors).toHaveLength(2);
    expect(read.errors[0]).toContain(paths.claudeJson);
  });

  it('lists exactly what claude mcp list prints when the files hold the same servers', async () => {
    await writeFile(
      paths.claudeJson,
      JSON.stringify({
        mcpServers: {
          sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
          docs: { command: 'npx', args: ['-y', 'docs-mcp'] },
        },
      }),
    );
    const cli = { bin: '/bin/claude', env: { PATH: '' } };
    const rows = await claudeMcp.list({
      exec: answering(0, LIST),
      cli,
      cwd: work,
      place: place(),
    });
    expect(rows).toStrictEqual(parseMcpList(LIST));
    expect(calls).toStrictEqual([
      {
        command: '/bin/claude',
        args: ['mcp', 'list'],
        options: { cwd: work, env: { PATH: '' }, timeoutMs: MCP_LIST_TIMEOUT_MS },
      },
    ]);
  });

  it('adds the servers the list left out after it, from the files', async () => {
    await files();
    const rows = await claudeMcp.list({
      exec: answering(0, LIST),
      cli: { bin: 'claude', env: {} },
      cwd: work,
      place: place(),
    });
    expect(rows.slice(0, 3)).toStrictEqual(parseMcpList(LIST));
    expect(rows.slice(3)).toStrictEqual([
      {
        id: 'mcp:old',
        name: 'old',
        kind: 'mcp',
        target: 'https://old',
        status: 'disabled',
        detail: 'Turned off for this project.',
        fix: null,
      },
      {
        id: 'mcp:fresh',
        name: 'fresh',
        kind: 'mcp',
        target: 'fresh-mcp',
        status: 'pending',
        detail:
          'Waiting for you to approve this project .mcp.json server in a Claude Code session.',
        fix: null,
      },
    ]);
  });

  it('keeps the failure row and shows the file servers when claude mcp list fails', async () => {
    await writeFile(
      paths.claudeJson,
      JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' } } }),
    );
    const rows = await claudeMcp.list({
      exec: answering(2, '', 'no auth'),
      cli: { bin: 'claude', env: {} },
      cwd: work,
      place: place(),
    });
    expect(rows).toStrictEqual([
      {
        id: 'mcp:list',
        name: 'MCP servers',
        kind: 'mcp',
        target: 'claude mcp list',
        status: 'failed',
        detail: 'Could not list the MCP servers: no auth',
        fix: null,
      },
      {
        id: 'mcp:docs',
        name: 'docs',
        kind: 'mcp',
        target: 'docs-mcp',
        status: 'unknown',
        detail: `Set up in ${paths.claudeJson}, but claude mcp list did not run.`,
        fix: null,
      },
    ]);
  });

  it('says a server the list left out was not reported', async () => {
    await writeFile(paths.claudeJson, JSON.stringify({ mcpServers: { extra: { command: 'x' } } }));
    const rows = await claudeMcp.list({
      exec: answering(0, ''),
      cli: { bin: 'claude', env: {} },
      cwd: work,
      place: place(),
    });
    expect(rows.map((row) => row.detail)).toStrictEqual([
      `Set up in ${paths.claudeJson}, but claude mcp list did not report it.`,
    ]);
  });

  it('adds with claude mcp add-json and removes with claude mcp remove, as before', async () => {
    const cli = { bin: '/bin/claude', env: { PATH: '' } };
    const server = { type: 'http' as const, url: 'https://s' };
    const exec = answering(0, '');
    expect(
      await claudeMcp.add({ exec, cli, cwd: home, name: 's', server, scope: 'user' }),
    ).toStrictEqual({ ok: true });
    expect(
      await claudeMcp.remove({ exec, cli, cwd: home, name: 's', scope: 'local' }),
    ).toStrictEqual({ ok: true });
    expect(calls).toStrictEqual([
      {
        command: '/bin/claude',
        args: ['mcp', 'add-json', '--scope', 'user', 's', JSON.stringify(server)],
        options: { cwd: home, env: { PATH: '' }, timeoutMs: 30_000 },
      },
      {
        command: '/bin/claude',
        args: ['mcp', 'remove', '--scope', 'local', 's'],
        options: { cwd: home, env: { PATH: '' }, timeoutMs: 30_000 },
      },
    ]);
    expect(
      await claudeMcp.add({
        exec: answering(1, 'taken', ''),
        cli,
        cwd: home,
        name: 's',
        server,
        scope: 'user',
      }),
    ).toStrictEqual({ ok: false, error: 'claude mcp add-json failed: taken' });
    expect(
      await claudeMcp.add({
        exec: answering(3, ''),
        cli,
        cwd: home,
        name: 's',
        server,
        scope: 'user',
      }),
    ).toStrictEqual({ ok: false, error: 'claude mcp add-json failed: exit 3' });
    expect(claudeMcp.signInArgs?.('sentry')).toStrictEqual(['mcp', 'login', 'sentry']);
    expect(claudeMcp.scopes[0]).toBe('user');
  });
});
