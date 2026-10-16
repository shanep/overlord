import { describe, expect, it, vi } from 'vitest';

import { defaultExec, makeIsAlive } from './process.js';

function codeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('defaultExec', () => {
  it('runs a command with arguments and returns stdout as text', async () => {
    const result = await defaultExec(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv.slice(1).join(","))', 'a', 'b c'],
      { timeoutMs: 10_000 },
    );
    expect(result).toStrictEqual({ stdout: 'a,b c' });
  });

  it('allows output past the 1 MB Node default', async () => {
    const result = await defaultExec(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(3 * 1024 * 1024))'],
      { timeoutMs: 10_000 },
    );
    expect(result.stdout).toHaveLength(3 * 1024 * 1024);
  });

  it('rejects when the command fails', async () => {
    await expect(
      defaultExec(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 10_000 }),
    ).rejects.toThrow(/Command failed/u);
  });

  it('kills the command at the timeout', async () => {
    const started = Date.now();
    const error: unknown = await defaultExec(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 20000)'],
      { timeoutMs: 200 },
    ).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('killed', true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('makeIsAlive', () => {
  it('is alive when kill succeeds, and sends signal 0', () => {
    const kill = vi.fn<(pid: number, signal: number) => void>();
    expect(makeIsAlive(kill)(1234)).toBe(true);
    expect(kill).toHaveBeenCalledWith(1234, 0);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('is alive on EPERM (exists, not ours)', () => {
    const isAlive = makeIsAlive(() => {
      throw codeError('EPERM');
    });
    expect(isAlive(1)).toBe(true);
  });

  it('is dead on ESRCH and on unexpected errors', () => {
    expect(
      makeIsAlive(() => {
        throw codeError('ESRCH');
      })(77),
    ).toBe(false);
    expect(
      makeIsAlive(() => {
        throw new Error('weird');
      })(77),
    ).toBe(false);
  });

  it('never signals process groups or bad process ids', () => {
    const kill = vi.fn<(pid: number, signal: number) => void>();
    const isAlive = makeIsAlive(kill);
    for (const pid of [0, -1, -1234, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(isAlive(pid)).toBe(false);
    }
    expect(kill).not.toHaveBeenCalled();
    expect(isAlive(1)).toBe(true);
    expect(kill).toHaveBeenCalledWith(1, 0);
  });

  it('uses process.kill by default', () => {
    const isAlive = makeIsAlive();
    expect(isAlive(process.pid)).toBe(true);
    // Far above pid_max on macOS and Linux.
    expect(isAlive(2 ** 30)).toBe(false);
  });
});
