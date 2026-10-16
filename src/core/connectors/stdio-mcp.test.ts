import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StdioToolCall } from './stdio-mcp.js';
import { callStdioTool, resultText } from './stdio-mcp.js';

// A stand-in MCP server, run with node. MODE picks how it misbehaves.
const SERVER = String.raw`
const mode = process.env.MODE;
let buffer = '';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (mode === 'exit') process.exit(3);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (mode === 'silent') continue;
    if (message.method === 'initialize') {
      if (mode === 'init-error') { send({ jsonrpc: '2.0', id: message.id, error: {} }); continue; }
      process.stdout.write('not json\n[1]\n');
      send({ jsonrpc: '2.0', method: 'notifications/message', params: {} });
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion } });
    } else if (message.method === 'tools/call') {
      const name = message.params.name;
      if (mode === 'call-error') send({ jsonrpc: '2.0', id: message.id, error: { message: 'no such tool' } });
      else if (mode === 'tool-error') send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'nope' }] } });
      else if (mode === 'no-content') send({ jsonrpc: '2.0', id: message.id, result: {} });
      else {
        const half = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: name }, { type: 'image' }, { type: 'text', text: 'two' }] } }) + '\n';
        process.stdout.write(half.slice(0, 10));
        setTimeout(() => process.stdout.write(half.slice(10)), 5);
      }
    }
  }
});
`;

describe('callStdioTool', () => {
  let dir: string;
  let script: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-stdio-'));
    script = path.join(dir, 'server.cjs');
    await writeFile(script, SERVER);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function call(mode: string, overrides: Partial<StdioToolCall> = {}): Promise<string> {
    return callStdioTool({
      command: process.execPath,
      args: [script],
      env: { MODE: mode },
      cwd: dir,
      tool: 'list_connected_browsers',
      timeoutMs: 5000,
      ...overrides,
    });
  }

  it('initializes, calls the tool and returns its text', async () => {
    await expect(call('ok')).resolves.toBe('list_connected_browsers\ntwo');
  });

  it('rejects with the server error', async () => {
    await expect(call('call-error')).rejects.toThrow('no such tool');
    await expect(call('init-error')).rejects.toThrow('the server returned an error');
    await expect(call('tool-error')).rejects.toThrow('nope');
    await expect(call('no-content')).rejects.toThrow('the tool answered without any content');
  });

  it('rejects when the server exits, hangs or cannot start', async () => {
    await expect(call('exit')).rejects.toThrow('exited 3 before it answered');
    await expect(call('silent', { timeoutMs: 300 })).rejects.toThrow(
      'did not answer within 0.3 seconds',
    );
    await expect(call('ok', { command: path.join(dir, 'missing') })).rejects.toThrow('ENOENT');
  });
});

describe('resultText', () => {
  it('uses a fallback message for a failed tool with no text', () => {
    expect(() => resultText({ isError: true, content: [] })).toThrow('the tool failed');
    expect(() => resultText(null)).toThrow('the tool answered without any content');
  });
});
