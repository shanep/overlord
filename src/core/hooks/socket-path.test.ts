import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SOCKET_ENV, socketPath } from './socket-path.js';

describe('socketPath', () => {
  it('puts the socket under the config dir on macOS and Linux', () => {
    expect(socketPath({ configDir: '/home/u/.claude' }, 'linux')).toBe(
      '/home/u/.claude/overlord/hook.sock',
    );
    expect(socketPath({ configDir: '/Users/u/.claude' }, 'darwin')).toBe(
      '/Users/u/.claude/overlord/hook.sock',
    );
  });

  it('uses the current platform by default', () => {
    expect(socketPath({ configDir: '/c' })).toBe(socketPath({ configDir: '/c' }, process.platform));
    expect(path.basename(socketPath({ configDir: '/c' }, 'linux'))).toBe('hook.sock');
  });

  it('uses a named pipe keyed by config dir on Windows', () => {
    const first = socketPath({ configDir: String.raw`C:\Users\u\.claude` }, 'win32');
    expect(first).toMatch(/^\\\\\.\\pipe\\overlord-hook-[0-9a-f]{16}$/u);
    expect(socketPath({ configDir: String.raw`C:\Users\u\.claude` }, 'win32')).toBe(first);
    expect(socketPath({ configDir: String.raw`D:\other` }, 'win32')).not.toBe(first);
  });

  it('names the override variable', () => {
    expect(SOCKET_ENV).toBe('OVERLORD_HOOK_SOCKET');
  });
});
