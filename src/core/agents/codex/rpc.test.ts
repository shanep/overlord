import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcConnection, RpcError, spawnAppServer, type RpcHandlers } from './rpc.js';

// A server that echoes each request's params back as its result, fails the
// "boom" method, asks the client one question and says goodbye on stderr.
const ECHO = String.raw`
import { createInterface } from 'node:readline';
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');
out({ method: 'hello', params: { from: 'server' } });
out({ id: 0, method: 'question', params: { asked: true } });
process.stdout.write('not json\n');
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'boom') {
    out({ id: message.id, error: { code: 7, message: 'bad' } });
  } else if (message.method !== undefined && message.id !== undefined) {
    out({ id: message.id, result: { echo: message.params, argv: process.argv.slice(2) } });
  } else if (message.id === 0) {
    out({ method: 'answered', params: message.result });
  }
}
process.stderr.write('bye\n');
`;

describe('spawnAppServer and RpcConnection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-codex-rpc-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a script with this Node and talks JSON-RPC over its stdio', async () => {
    const script = path.join(dir, 'server.mjs');
    await writeFile(script, ECHO);
    const server = spawnAppServer({
      command: script,
      args: ['app-server', '-c', 'a=1'],
      cwd: dir,
      env: { PATH: process.env['PATH'] ?? '' },
    });
    const notices: unknown[] = [];
    const handlers: RpcHandlers = {
      notification: (method, params) => {
        notices.push({ method, params });
      },
      request: async (method, params) => {
        await Promise.resolve();
        return { result: { method, params } };
      },
    };
    const rpc = new RpcConnection(server, handlers);
    const reading = rpc.read();
    expect(await rpc.request('ping', { n: 1 })).toStrictEqual({
      echo: { n: 1 },
      argv: ['app-server', '-c', 'a=1'],
    });
    await expect(rpc.request('boom', null)).rejects.toThrow(new RpcError('boom', 7, 'bad'));
    server.closeInput();
    await reading;
    expect(notices).toStrictEqual([
      { method: 'hello', params: { from: 'server' } },
      { method: 'answered', params: { method: 'question', params: { asked: true } } },
    ]);
    expect(await server.exited).toStrictEqual({ code: 0, signal: null, stderr: 'bye\n' });
    await expect(rpc.request('late', null)).rejects.toThrow('codex app-server closed its output');
  });

  it('says why a command could not start', async () => {
    const server = spawnAppServer({
      command: path.join(dir, 'no-such-codex'),
      args: [],
      cwd: dir,
      env: {},
    });
    server.write('{}');
    const exit = await server.exited;
    expect(exit).toMatchObject({ code: null, signal: null });
    expect(exit.stderr).toContain('ENOENT');
  });

  it('kills a server that will not exit', async () => {
    const script = path.join(dir, 'stuck.mjs');
    await writeFile(script, 'setInterval(() => {}, 1000);\n');
    const server = spawnAppServer({ command: script, args: [], cwd: dir, env: {} });
    server.kill();
    expect(await server.exited).toMatchObject({ code: null, signal: 'SIGTERM' });
  });
});
