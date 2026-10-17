import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SOCKET_ENV, socketPath } from './socket-path.js';

describe('socketPath', () => {
  it('puts the socket in ~/.overlord on macOS and Linux', () => {
    expect(socketPath({ home: '/home/u' }, 'linux')).toBe('/home/u/.overlord/hook.sock');
    expect(socketPath({ home: '/Users/u' }, 'darwin')).toBe('/Users/u/.overlord/hook.sock');
  });

  it('uses the current platform by default', () => {
    expect(socketPath({ home: '/h' })).toBe(socketPath({ home: '/h' }, process.platform));
    expect(path.basename(socketPath({ home: '/h' }, 'linux'))).toBe('hook.sock');
  });

  it('uses a named pipe keyed by home on Windows', () => {
    const first = socketPath({ home: String.raw`C:\Users\u` }, 'win32');
    expect(first).toMatch(/^\\\\\.\\pipe\\overlord-hook-[0-9a-f]{16}$/u);
    expect(socketPath({ home: String.raw`C:\Users\u` }, 'win32')).toBe(first);
    expect(socketPath({ home: String.raw`D:\other` }, 'win32')).not.toBe(first);
  });

  it('names the override variable', () => {
    expect(SOCKET_ENV).toBe('OVERLORD_HOOK_SOCKET');
  });
});
