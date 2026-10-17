import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeMcp, MCP_LIST_TIMEOUT_MS } from '../agents/claude/mcp.js';
import type { McpStore } from '../agents/types.js';
import { resolveClaudePaths } from '../paths.js';
import type { Exec, ExecOptions, ExecResult } from '../sync/exec.js';

import type { CheckInput, McpSource } from './check.js';
import { CHROME_TIMEOUT_MS, checkConnectors, extensionInstalled } from './check.js';
import type { StdioToolCall } from './stdio-mcp.js';

const listsGmail: Exec = async () => {
  await Promise.resolve();
  return { code: 0, stdout: 'gmail: https://g - ✔ Connected\n', stderr: '' };
};

const listsNothing: Exec = async () => {
  await Promise.resolve();
  return { code: 0, stdout: '', stderr: '' };
};

describe('checkConnectors', () => {
  let home: string;
  let claudeJson: string;
  let execCalls: { command: string; args: readonly string[]; options: ExecOptions }[];
  let toolCalls: StdioToolCall[];

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ovl-check-')));
    claudeJson = path.join(home, '.claude.json');
    execCalls = [];
    toolCalls = [];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function input(
    exec: Exec,
    answer: () => Promise<string>,
    more: readonly McpSource[] = [],
  ): CheckInput {
    const cli = { bin: '/bin/claude', env: { PATH: '' } };
    return {
      claude: cli,
      mcp: [{ agent: 'claude-code', store: claudeMcp, cli }, ...more],
      place: {
        home,
        env: { PATH: '' },
        claude: resolveClaudePaths({ home, platform: 'linux', env: {} }),
        cwd: '/work',
      },
      cwd: '/work',
      home,
      claudeJson,
      platform: 'linux',
      exec: async (command, args, options): Promise<ExecResult> => {
        execCalls.push({ command, args, options });
        return exec(command, args, options);
      },
      callTool: async (call): Promise<string> => {
        toolCalls.push(call);
        return answer();
      },
    };
  }

  it('puts Chrome and headless Chrome ahead of the MCP servers', async () => {
    const connectors = await checkConnectors(
      input(listsGmail, async () => {
        await Promise.resolve();
        return '[{"displayName":"Mac"}]';
      }),
    );
    expect(connectors.map((connector) => [connector.id, connector.status])).toStrictEqual([
      ['chrome:claude-in-chrome', 'ok'],
      ['headless:chrome', 'missing'],
      ['mcp:gmail', 'ok'],
    ]);
    expect(execCalls).toStrictEqual([
      {
        command: '/bin/claude',
        args: ['mcp', 'list'],
        options: { cwd: '/work', env: { PATH: '' }, timeoutMs: MCP_LIST_TIMEOUT_MS },
      },
    ]);
    expect(toolCalls).toStrictEqual([
      {
        command: '/bin/claude',
        args: ['--claude-in-chrome-mcp'],
        env: { PATH: '' },
        cwd: home,
        tool: 'list_connected_browsers',
        timeoutMs: CHROME_TIMEOUT_MS,
      },
    ]);
  });

  it('turns a failed list and a failed probe into rows', async () => {
    let code = 2;
    let stderr = 'no auth';
    const exec: Exec = async () => {
      await Promise.resolve();
      return { code, stdout: '', stderr };
    };
    const failing = input(exec, async () => {
      await Promise.resolve();
      throw new Error('spawn failed');
    });
    const [chrome, , servers] = await checkConnectors(failing);
    expect(chrome?.detail).toBe(
      'Could not ask Claude Code which browsers are connected: spawn failed',
    );
    expect(servers).toStrictEqual({
      id: 'mcp:list',
      name: 'MCP servers',
      kind: 'mcp',
      target: 'claude mcp list',
      status: 'failed',
      detail: 'Could not list the MCP servers: no auth',
      fix: null,
    });
    code = 124;
    stderr = '  ';
    const results = await checkConnectors(
      input(exec, async () => {
        await Promise.resolve();
        // Covers a probe that throws something other than an Error.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain';
      }),
    );
    const timedOut = results[2];
    expect(timedOut?.detail).toBe('Could not list the MCP servers: claude mcp list exited 124');
  });

  it('adds each other agent after Claude Code, and turns a store that throws into a row', async () => {
    const throws: McpStore = {
      ...claudeMcp,
      list: async () => {
        await Promise.resolve();
        throw new Error('broken');
      },
    };
    const rows = await checkConnectors(
      input(listsGmail, async () => {
        await Promise.resolve();
        return '[]';
      }, [{ agent: 'codex', store: throws, cli: { bin: '/bin/codex', env: {} } }]),
    );
    expect(rows.map((row) => [row.id, row.status, row.agent])).toStrictEqual([
      ['chrome:claude-in-chrome', 'missing', undefined],
      ['headless:chrome', 'missing', undefined],
      ['mcp:gmail', 'ok', undefined],
      ['codex/mcp:list', 'failed', 'codex'],
    ]);
    expect(rows[3]?.detail).toBe('Could not list the MCP servers: broken');
  });

  it('leaves Claude in Chrome out when Claude Code is not checked', async () => {
    const rows = await checkConnectors({
      ...input(listsNothing, async () => {
        await Promise.resolve();
        return '[]';
      }),
      claude: null,
      mcp: [],
    });
    expect(rows.map((row) => row.id)).toStrictEqual(['headless:chrome']);
    expect(toolCalls).toStrictEqual([]);
  });

  it('skips the Chrome probe when the extension is not installed', async () => {
    await writeFile(claudeJson, JSON.stringify({ cachedChromeExtensionInstalled: false }));
    const [chrome] = await checkConnectors(
      input(listsNothing, async () => {
        await Promise.resolve();
        return '[]';
      }),
    );
    expect(chrome?.status).toBe('missing');
    expect(toolCalls).toStrictEqual([]);
  });
});

describe('extensionInstalled', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-ext-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the flag Claude Code caches, and null when it is not there', async () => {
    const file = path.join(dir, '.claude.json');
    expect(await extensionInstalled(file)).toBeNull();
    await writeFile(file, '{"cachedChromeExtensionInstalled":true}');
    expect(await extensionInstalled(file)).toBe(true);
    await writeFile(file, '{"cachedChromeExtensionInstalled":"yes"}');
    expect(await extensionInstalled(file)).toBeNull();
    await writeFile(file, '{}');
    expect(await extensionInstalled(file)).toBeNull();
    await writeFile(file, 'null');
    expect(await extensionInstalled(file)).toBeNull();
  });
});
