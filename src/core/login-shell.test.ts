import { describe, expect, it } from 'vitest';

import { loginShellLaunch, shellQuote } from './login-shell.js';

describe('shellQuote', () => {
  it('leaves safe words alone', () => {
    expect(shellQuote('claude')).toBe('claude');
    expect(shellQuote('--resume=abc-123')).toBe('--resume=abc-123');
    expect(shellQuote('/a/b.c@x%y+z:1')).toBe('/a/b.c@x%y+z:1');
  });

  it('single quotes anything else and escapes embedded quotes', () => {
    expect(shellQuote('fix the bug')).toBe("'fix the bug'");
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`);
  });
});

describe('loginShellLaunch', () => {
  it('runs claude through the user shell as a login shell', () => {
    expect(
      loginShellLaunch({
        command: '/Users/me/.local/bin/claude',
        args: ['--resume', 'abc'],
        shell: '/opt/homebrew/bin/fish',
        platform: 'darwin',
      }),
    ).toStrictEqual({
      shellPath: '/opt/homebrew/bin/fish',
      shellArgs: ['-l', '-i', '-c', 'exec /Users/me/.local/bin/claude --resume abc'],
    });
  });

  it('quotes arguments with spaces', () => {
    const launch = loginShellLaunch({
      command: 'claude',
      args: ['--cloud', "Bob's fix"],
      shell: '/bin/bash',
      platform: 'linux',
    });
    expect(launch.shellArgs[3]).toBe(String.raw`exec claude --cloud 'Bob'\''s fix'`);
  });

  it('falls back to zsh on macOS and bash elsewhere when SHELL is unset or empty', () => {
    const base = { command: 'claude', args: [] };
    expect(loginShellLaunch({ ...base, shell: undefined, platform: 'darwin' }).shellPath).toBe(
      '/bin/zsh',
    );
    expect(loginShellLaunch({ ...base, shell: '', platform: 'linux' }).shellPath).toBe('/bin/bash');
    expect(
      loginShellLaunch({ ...base, shell: undefined, platform: 'linux' }).shellArgs,
    ).toStrictEqual(['-l', '-i', '-c', 'exec claude']);
  });

  it('starts the program directly on Windows', () => {
    expect(
      loginShellLaunch({
        command: 'claude.exe',
        args: ['-p'],
        shell: undefined,
        platform: 'win32',
      }),
    ).toStrictEqual({ shellPath: 'claude.exe', shellArgs: ['-p'] });
  });
});
