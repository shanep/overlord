import { describe, expect, it } from 'vitest';

import {
  ENV_MARKER,
  loginShellEnvLaunch,
  loginShellLaunch,
  parseShellEnv,
  shellQuote,
} from './login-shell.js';

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

describe('loginShellEnvLaunch', () => {
  it('prints the environment between markers from a login, interactive shell', () => {
    expect(loginShellEnvLaunch({ shell: '/bin/zsh', platform: 'darwin' })).toStrictEqual({
      shellPath: '/bin/zsh',
      shellArgs: ['-l', '-i', '-c', `printf '%s' ${ENV_MARKER}; env -0; printf '%s' ${ENV_MARKER}`],
    });
  });

  it('falls back to the default shell when SHELL is unset or empty', () => {
    expect(loginShellEnvLaunch({ shell: undefined, platform: 'linux' })?.shellPath).toBe(
      '/bin/bash',
    );
    expect(loginShellEnvLaunch({ shell: '', platform: 'darwin' })?.shellPath).toBe('/bin/zsh');
  });

  it('skips Windows, which already has the full environment', () => {
    expect(loginShellEnvLaunch({ shell: 'cmd.exe', platform: 'win32' })).toBeNull();
  });
});

function fenced(body: string): string {
  return `banner\n${ENV_MARKER}${body}${ENV_MARKER}\nprompt`;
}

describe('parseShellEnv', () => {
  it('reads NUL separated variables and ignores output around the markers', () => {
    expect(parseShellEnv(fenced('PATH=/opt/bin:/bin\0EMPTY=\0MULTI=a\nb=c\0'))).toStrictEqual({
      PATH: '/opt/bin:/bin',
      EMPTY: '',
      MULTI: 'a\nb=c',
    });
  });

  it('drops variables that only describe the throwaway shell', () => {
    expect(
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- PWD is the working directory
      parseShellEnv(fenced('_=/usr/bin/env\0OLDPWD=/a\0PWD=/b\0SHLVL=2\0KEEP=1\0')),
    ).toStrictEqual({ KEEP: '1' });
  });

  it('skips entries without a name', () => {
    expect(parseShellEnv(fenced('=oops\0junk\0OK=1'))).toStrictEqual({ OK: '1' });
  });

  it('returns null when the markers are missing', () => {
    expect(parseShellEnv('')).toBeNull();
    expect(parseShellEnv(`${ENV_MARKER}PATH=/bin`)).toBeNull();
  });
});
