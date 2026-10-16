import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventBus } from '../core/bus.js';
import { HookServer } from '../core/hooks/server.js';

import {
  CONNECT_TIMEOUT_MS,
  parseInput,
  PERMISSION_TIMEOUT_MS,
  readStdin,
  REPLY_TIMEOUT_MS,
  resolveSocketPath,
  runHook,
} from './client.js';

const stop = JSON.stringify({ session_id: 's', hook_event_name: 'Stop' });
const permission = JSON.stringify({
  session_id: 's',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
});

function idOf(line: string): string {
  const value: unknown = JSON.parse(line);
  return typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string'
    ? value.id
    : '';
}

type Responder = (socket: net.Socket, line: string) => void;

describe('parseInput', () => {
  it('reads the event name and payload', () => {
    expect(parseInput(stop)).toStrictEqual({
      name: 'Stop',
      event: { session_id: 's', hook_event_name: 'Stop' },
    });
  });

  it('is null for anything that is not a hook payload', () => {
    expect(parseInput('')).toBeNull();
    expect(parseInput('{')).toBeNull();
    expect(parseInput('null')).toBeNull();
    expect(parseInput('3')).toBeNull();
    expect(parseInput('{"session_id":"s"}')).toBeNull();
    expect(parseInput('{"hook_event_name":5}')).toBeNull();
  });
});

describe('resolveSocketPath', () => {
  it('prefers the override variable', () => {
    expect(
      resolveSocketPath(
        { OVERLORD_HOOK_SOCKET: '/x.sock', CLAUDE_CONFIG_DIR: '/c' },
        '/h',
        'linux',
      ),
    ).toBe('/x.sock');
  });

  it('uses CLAUDE_CONFIG_DIR, then the home directory', () => {
    expect(resolveSocketPath({ CLAUDE_CONFIG_DIR: '/c' }, '/h', 'linux')).toBe(
      '/c/overlord/hook.sock',
    );
    expect(
      resolveSocketPath({ OVERLORD_HOOK_SOCKET: '', CLAUDE_CONFIG_DIR: '' }, '/h', 'darwin'),
    ).toBe('/h/.claude/overlord/hook.sock');
    expect(resolveSocketPath({}, '/h', 'linux')).toBe('/h/.claude/overlord/hook.sock');
  });

  it('uses a named pipe on Windows', () => {
    expect(resolveSocketPath({}, String.raw`C:\Users\u`, 'win32')).toMatch(
      /^\\\\\.\\pipe\\overlord-hook-/u,
    );
  });
});

describe('readStdin', () => {
  it('joins string and buffer chunks', async () => {
    expect(await readStdin(Readable.from(['{"a":', Buffer.from('1}')]))).toBe('{"a":1}');
    expect(await readStdin(Readable.from([]))).toBe('');
  });
});

describe('runHook', () => {
  let dir: string;
  let file: string;
  let servers: net.Server[];
  let received: string[];

  async function fakeOverlord(respond: Responder): Promise<void> {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          received.push(part);
          respond(socket, part);
        }
      });
      socket.on('error', () => {
        // The client may hang up first.
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(file, resolve);
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-client-'));
    file = path.join(dir, 'hook.sock');
    servers = [];
    received = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      servers.map(
        async (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('has short budgets except for permission requests', () => {
    expect(CONNECT_TIMEOUT_MS).toBe(200);
    expect(REPLY_TIMEOUT_MS).toBe(2000);
    expect(PERMISSION_TIMEOUT_MS).toBe(605_000);
  });

  it('prints nothing when the input is not a hook payload', async () => {
    expect(await runHook({ input: 'nope', socketPath: file })).toStrictEqual({
      stdout: '',
      exitCode: 0,
    });
  });

  it('prints nothing at once when Overlord is not running', async () => {
    const started = Date.now();
    expect(await runHook({ input: stop, socketPath: file })).toStrictEqual({
      stdout: '',
      exitCode: 0,
    });
    expect(Date.now() - started).toBeLessThan(CONNECT_TIMEOUT_MS);
  });

  it('sends the payload with an id and prints a non-empty reply', async () => {
    await fakeOverlord((socket, line) => {
      socket.write(
        `not json\n{"id":"other","output":{"x":1}}\n{"id":"${idOf(line)}","output":{"ok":true}}\n`,
      );
    });
    const result = await runHook({ input: permission, socketPath: file, newId: () => 'id-1' });
    expect(result).toStrictEqual({ stdout: '{"ok":true}', exitCode: 0 });
    expect(received.map((line): unknown => JSON.parse(line))).toStrictEqual([
      { id: 'id-1', event: parseInput(permission)?.event },
    ]);
  });

  it('waits for a reply split across chunks', async () => {
    await fakeOverlord((socket, line) => {
      socket.write('{"id":');
      setTimeout(() => {
        socket.write(`"${idOf(line)}","output":{"late":1}}\n`);
      }, 20);
    });
    expect(await runHook({ input: stop, socketPath: file })).toStrictEqual({
      stdout: '{"late":1}',
      exitCode: 0,
    });
  });

  it('prints nothing for an empty reply', async () => {
    await fakeOverlord((socket, line) => {
      socket.write(`{"id":"${idOf(line)}","output":{}}\n`);
    });
    expect(await runHook({ input: stop, socketPath: file })).toStrictEqual({
      stdout: '',
      exitCode: 0,
    });
    expect(idOf(received[0] ?? '')).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('gives up when connecting takes too long', async () => {
    await fakeOverlord(() => {
      // Never answers.
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Advancing before awaiting means the connect has had no chance to finish.
    const pending = runHook({ input: stop, socketPath: file, replyTimeoutMs: 60_000 });
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    expect(await pending).toStrictEqual({ stdout: '', exitCode: 0 });
    const custom = runHook({
      input: stop,
      socketPath: file,
      connectTimeoutMs: 5,
      replyTimeoutMs: 60_000,
    });
    vi.advanceTimersByTime(5);
    expect(await custom).toStrictEqual({ stdout: '', exitCode: 0 });
    expect(received).toStrictEqual([]);
  });

  it('waits only the reply budget for ordinary events', async () => {
    await fakeOverlord(() => {
      // Never answers.
    });
    const started = Date.now();
    const result = await runHook({
      input: stop,
      socketPath: file,
      replyTimeoutMs: 30,
      permissionTimeoutMs: 60_000,
    });
    expect(result).toStrictEqual({ stdout: '', exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(received).toHaveLength(1);
  });

  it('waits the permission budget for permission requests', async () => {
    await fakeOverlord(() => {
      // Never answers.
    });
    const started = Date.now();
    const result = await runHook({
      input: permission,
      socketPath: file,
      replyTimeoutMs: 60_000,
      permissionTimeoutMs: 30,
    });
    expect(result).toStrictEqual({ stdout: '', exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('prints nothing when Overlord hangs up', async () => {
    await fakeOverlord((socket) => {
      socket.end();
    });
    expect(await runHook({ input: stop, socketPath: file })).toStrictEqual({
      stdout: '',
      exitCode: 0,
    });
  });

  it('prints nothing when the reply is too long', async () => {
    await fakeOverlord((socket) => {
      socket.write('x'.repeat(100));
    });
    expect(await runHook({ input: stop, socketPath: file, maxLineBytes: 10 })).toStrictEqual({
      stdout: '',
      exitCode: 0,
    });
  });

  it('gets an auto-approval from a real HookServer', async () => {
    const server = new HookServer({
      socketPath: path.join(dir, 'real', 'hook.sock'),
      bus: new EventBus(),
      rules: [
        { id: 'r', enabled: true, behavior: 'allow', tool: 'Bash', pattern: 'ls', description: '' },
      ],
    });
    await server.start();
    try {
      const result = await runHook({ input: permission, socketPath: server.socketPath });
      expect(JSON.parse(result.stdout)).toStrictEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      });
      expect(await runHook({ input: stop, socketPath: server.socketPath })).toStrictEqual({
        stdout: '',
        exitCode: 0,
      });
    } finally {
      await server.stop();
    }
  });
});
