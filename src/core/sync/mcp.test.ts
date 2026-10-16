import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractMcpSecrets,
  mcpServersFrom,
  readMcpFile,
  readProjectMcpServers,
  readUserMcpServers,
  secretNameFor,
  serverHasSecrets,
} from './mcp.js';
import { fakePaths, scratchDir, writeTree } from './test-helpers/fixtures.js';

const token = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('reading servers', () => {
  it('keeps only object configs, sorted by name', () => {
    expect(mcpServersFrom({ b: { command: 'b' }, a: { command: 'a' }, c: 'bad' })).toStrictEqual([
      { name: 'a', config: { command: 'a' } },
      { name: 'b', config: { command: 'b' } },
    ]);
    expect(mcpServersFrom(null)).toStrictEqual([]);
  });

  it('reads user servers from ~/.claude.json and nothing else', async () => {
    const home = await scratchDir();
    await writeTree(home, {
      '.claude.json': JSON.stringify({
        mcpServers: { gh: { command: 'gh' } },
        projects: { '/x': { mcpServers: { local: { command: 'l' } } } },
      }),
    });
    expect(await readUserMcpServers(fakePaths(home))).toStrictEqual([
      { name: 'gh', config: { command: 'gh' } },
    ]);
  });

  it('reads .mcp.json and tolerates missing or odd files', async () => {
    const dir = await scratchDir();
    await writeTree(dir, {
      '.mcp.json': '{"mcpServers":{"p":{"url":"https://x"}}}',
      'odd.json': '[]',
    });
    expect(await readProjectMcpServers(dir)).toStrictEqual([
      { name: 'p', config: { url: 'https://x' } },
    ]);
    expect(await readMcpFile(path.join(dir, 'odd.json'))).toStrictEqual([]);
    expect(await readMcpFile(path.join(dir, 'missing.json'))).toStrictEqual([]);
  });
});

describe('serverHasSecrets', () => {
  it('looks at env, headers and args', () => {
    expect(serverHasSecrets({ env: { GITHUB_TOKEN: 'abcdefgh123' } })).toBe(true);
    expect(serverHasSecrets({ headers: { Authorization: `Bearer ${token}` } })).toBe(true);
    expect(serverHasSecrets({ args: ['--token', token] })).toBe(true);
    expect(serverHasSecrets({ env: { GITHUB_TOKEN: '${secret:GH}' }, args: ['-y', 3] })).toBe(
      false,
    );
    expect(serverHasSecrets({ command: 'x', args: 'not-a-list' })).toBe(false);
  });
});

describe('extractMcpSecrets', () => {
  it('moves secrets to placeholders and returns the values', () => {
    const result = extractMcpSecrets([
      {
        name: 'git-hub',
        config: {
          command: 'npx',
          args: ['server', token, 7],
          env: { GITHUB_TOKEN: 'abcdefgh123', LOG: 'debug' },
          headers: { 'X-Api-Key': 'abcdefgh123' },
        },
      },
      { name: 'plain', config: { url: 'https://x', env: 'odd' } },
    ]);
    expect(result).toStrictEqual({
      servers: {
        'git-hub': {
          command: 'npx',
          args: ['server', '${secret:MCP_GIT_HUB_ARG_1}', 7],
          env: { GITHUB_TOKEN: '${secret:MCP_GIT_HUB_GITHUB_TOKEN}', LOG: 'debug' },
          headers: { 'X-Api-Key': '${secret:MCP_GIT_HUB_X_API_KEY}' },
        },
        plain: { url: 'https://x', env: 'odd' },
      },
      secrets: [
        { name: 'MCP_GIT_HUB_GITHUB_TOKEN', value: 'abcdefgh123' },
        { name: 'MCP_GIT_HUB_X_API_KEY', value: 'abcdefgh123' },
        { name: 'MCP_GIT_HUB_ARG_1', value: token },
      ],
    });
  });

  it('keeps a non-list args value as it was', () => {
    const result = extractMcpSecrets([{ name: 'a', config: { args: 'x' } }]);
    expect(result.servers['a']).toStrictEqual({ args: 'x' });
  });

  it('names secrets safely', () => {
    expect(secretNameFor('my.server', 'x-key')).toBe('MCP_MY_SERVER_X_KEY');
  });
});
