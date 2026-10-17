import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveClaudePaths } from '../../paths.js';
import type { Exec, ExecOptions } from '../../sync/exec.js';
import { createNodeExec } from '../../sync/exec.js';
import type { McpPlace } from '../types.js';

import { addArgs, copilotHome, copilotMcp } from './mcp.js';

const FAKE_COPILOT = fileURLToPath(
  new URL('../../../../test/fake-agents/copilot/fake-copilot-mcp.mjs', import.meta.url),
);

/** Runs the fake the way the store would run copilot, through node since it is a script. */
const nodeExec = createNodeExec();
const runFake: Exec = async (command, args, options) =>
  nodeExec(process.execPath, [command, ...args], options);

describe('the Copilot MCP store', () => {
  let home: string;
  let copilot: string;
  let work: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ovl-copilot-mcp-')));
    copilot = path.join(home, 'copilot-home');
    work = path.join(home, 'work');
    await mkdir(copilot, { recursive: true });
    await mkdir(path.join(work, '.github'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function place(cwd: string | null = work): McpPlace {
    return {
      home,
      env: { COPILOT_HOME: copilot },
      claude: resolveClaudePaths({ home, platform: 'linux', env: {} }),
      cwd,
    };
  }

  it('finds COPILOT_HOME, or ~/.copilot without it', () => {
    expect(copilotHome('/h', { COPILOT_HOME: '/c' })).toBe('/c');
    expect(copilotHome('/h', {})).toBe(path.join('/h', '.copilot'));
  });

  it('reads the workspace files before the user file, with what settings turn off', async () => {
    await writeFile(
      path.join(copilot, 'mcp-config.json'),
      JSON.stringify({
        mcpServers: {
          github: { type: 'local', command: 'npx', args: ['-y', 'gh-mcp'], tools: ['*'] },
          notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
          broken: 'nope',
        },
      }),
    );
    await writeFile(
      path.join(copilot, 'settings.json'),
      '// User settings belong in settings.json.\n{ "disabledMcpServers": ["notion"] }\n',
    );
    await writeFile(
      path.join(work, '.mcp.json'),
      JSON.stringify({ mcpServers: { github: { command: 'gh-local' } } }),
    );
    await writeFile(
      path.join(work, '.github', 'mcp.json'),
      JSON.stringify({ mcpServers: { stream: { type: 'sse', url: 'https://s' } } }),
    );
    const read = await copilotMcp.read(place());
    expect(read.errors).toStrictEqual([]);
    expect(
      read.servers.map((server) => [
        server.name,
        server.scope,
        server.transport,
        server.target,
        server.state,
      ]),
    ).toStrictEqual([
      ['github', 'project', 'stdio', 'gh-local', 'on'],
      ['stream', 'project', 'sse', 'https://s', 'on'],
      ['github', 'user', 'stdio', 'npx -y gh-mcp', 'on'],
      ['notion', 'user', 'http', 'https://mcp.notion.com/mcp', 'off'],
    ]);
    expect(read.servers[0]?.file).toBe(path.join(work, '.mcp.json'));
    const userOnly = await copilotMcp.read(place(null));
    expect(userOnly.servers.map((server) => server.name)).toStrictEqual(['github', 'notion']);
  });

  it('lists each name once as a Copilot row, and says when a file will not parse', async () => {
    await writeFile(
      path.join(copilot, 'mcp-config.json'),
      JSON.stringify({ mcpServers: { github: { command: 'npx' } } }),
    );
    await writeFile(path.join(work, '.mcp.json'), '{ not json');
    const rows = await copilotMcp.list({
      exec: async () => {
        await Promise.resolve();
        throw new Error('list must not run copilot');
      },
      cli: { bin: 'copilot', env: {} },
      cwd: work,
      place: place(),
    });
    expect(rows.map((row) => [row.id, row.status, row.agent])).toStrictEqual([
      ['copilot/mcp:github', 'unchecked', 'copilot'],
      ['copilot/mcp:files', 'failed', 'copilot'],
    ]);
    expect(rows[1]?.detail).toContain(path.join(work, '.mcp.json'));
  });

  it('builds copilot mcp add args with options before the name', () => {
    expect(
      addArgs('gh', { type: 'stdio', command: 'npx', args: ['-y', 'gh'], env: { T: 'x' } }),
    ).toStrictEqual(['mcp', 'add', '--env', 'T=x', 'gh', '--', 'npx', '-y', 'gh']);
    expect(
      addArgs('st', { type: 'http', url: 'https://st', headers: { Authorization: 'Bearer k' } }),
    ).toStrictEqual([
      'mcp',
      'add',
      '--transport',
      'http',
      '--header',
      'Authorization: Bearer k',
      'st',
      'https://st',
    ]);
    expect(addArgs('s', { type: 'sse', url: 'https://s' })).toStrictEqual([
      'mcp',
      'add',
      '--transport',
      'sse',
      's',
      'https://s',
    ]);
  });

  it('adds and removes through copilot mcp in user scope only', async () => {
    const calls: { args: readonly string[]; options: ExecOptions }[] = [];
    let code = 0;
    const exec: Exec = async (_command, args, options) => {
      await Promise.resolve();
      calls.push({ args, options });
      return { code, stdout: '', stderr: code === 0 ? '' : 'exists' };
    };
    const base = { exec, cli: { bin: '/bin/copilot', env: { A: '1' } }, cwd: home, name: 'gh' };
    expect(
      await copilotMcp.add({
        ...base,
        server: { type: 'stdio', command: 'gh-mcp', args: [] },
        scope: 'user',
      }),
    ).toStrictEqual({ ok: true });
    expect(await copilotMcp.remove({ ...base, scope: 'user' })).toStrictEqual({ ok: true });
    code = 1;
    expect(await copilotMcp.remove({ ...base, scope: 'user' })).toStrictEqual({
      ok: false,
      error: 'copilot mcp remove failed: exists',
    });
    expect(await copilotMcp.remove({ ...base, scope: 'project' })).toStrictEqual({
      ok: false,
      error: 'Copilot adds and removes servers in the user file only.',
    });
    expect(calls.map((call) => call.args)).toStrictEqual([
      ['mcp', 'add', 'gh', '--', 'gh-mcp'],
      ['mcp', 'remove', 'gh'],
      ['mcp', 'remove', 'gh'],
    ]);
    expect(calls[0]?.options).toStrictEqual({ cwd: home, env: { A: '1' }, timeoutMs: 30_000 });
    expect(copilotMcp.signInArgs).toBeUndefined();
  });

  it('adds a server a fake copilot writes to mcp-config.json, which the list then shows', async () => {
    const base = {
      exec: runFake,
      cli: { bin: FAKE_COPILOT, env: { COPILOT_HOME: copilot } },
      cwd: home,
      scope: 'user' as const,
    };
    const added = await copilotMcp.add({
      ...base,
      name: 'docs',
      server: { type: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'], env: { K: 'v' } },
    });
    expect(added).toStrictEqual({ ok: true });
    const remote = await copilotMcp.add({
      ...base,
      name: 'linear',
      server: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { A: 'b' } },
    });
    expect(remote).toStrictEqual({ ok: true });
    const again = await copilotMcp.add({
      ...base,
      name: 'docs',
      server: { type: 'stdio', command: 'npx', args: [] },
    });
    expect(again).toStrictEqual({
      ok: false,
      error: 'copilot mcp add failed: Server "docs" already exists',
    });
    const found = await copilotMcp.read(place(null));
    expect(found.errors).toStrictEqual([]);
    expect(
      found.servers.map((server) => [server.name, server.transport, server.target]),
    ).toStrictEqual([
      ['docs', 'stdio', 'npx -y docs-mcp'],
      ['linear', 'http', 'https://mcp.linear.app/mcp'],
    ]);
    expect(await copilotMcp.remove({ ...base, name: 'docs' })).toStrictEqual({ ok: true });
    const left = await copilotMcp.read(place(null));
    expect(left.servers.map((server) => server.name)).toStrictEqual(['linear']);
  });
});
