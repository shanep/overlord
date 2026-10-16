import { describe, expect, it } from 'vitest';

import { resolved } from '../../../test/fake-claude/fake-query.js';
import { ENV_MARKER } from '../login-shell.js';

import { once, readLoginShellEnv, SHELL_ENV_TIMEOUT_MS } from './shell-env.js';
import { ok, recordingExec } from './test-helpers/fixtures.js';

const shellOutput = (body: string): string => `${ENV_MARKER}${body}${ENV_MARKER}`;

describe('readLoginShellEnv', () => {
  it('layers the login shell environment over the editor one', async () => {
    const { exec, calls } = recordingExec(() => ok(shellOutput('PATH=/opt/bin:/bin\0TOKEN=x\0')));
    const env = await readLoginShellEnv(
      exec,
      { SHELL: '/bin/zsh', PATH: '/bin', EDITOR_ONLY: 'yes' },
      'darwin',
    );
    expect(env).toStrictEqual({
      SHELL: '/bin/zsh',
      PATH: '/opt/bin:/bin',
      EDITOR_ONLY: 'yes',
      TOKEN: 'x',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/bin/zsh');
    expect(calls[0]?.args.slice(0, 3)).toStrictEqual(['-l', '-i', '-c']);
    expect(calls[0]?.options).toStrictEqual({ timeoutMs: SHELL_ENV_TIMEOUT_MS });
  });

  it('keeps the editor environment when the shell prints no environment', async () => {
    const { exec } = recordingExec();
    const base = { SHELL: '/bin/bash', PATH: '/bin' };
    expect(await readLoginShellEnv(exec, base, 'linux')).toBe(base);
  });

  it('does not run a shell on Windows', async () => {
    const { exec, calls } = recordingExec();
    const base = { PATH: String.raw`C:\bin` };
    expect(await readLoginShellEnv(exec, base, 'win32')).toBe(base);
    expect(calls).toHaveLength(0);
  });
});

describe('once', () => {
  it('loads on the first call and shares the result after that', async () => {
    let loads = 0;
    const load = once(async () => {
      loads += 1;
      return resolved(loads);
    });
    expect(loads).toBe(0);
    expect(await Promise.all([load(), load()])).toStrictEqual([1, 1]);
    expect(await load()).toBe(1);
    expect(loads).toBe(1);
  });
});
