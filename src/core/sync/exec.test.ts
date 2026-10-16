import { describe, expect, it } from 'vitest';

import { createNodeExec, exitCodeOf, NOT_FOUND_CODE, TIMEOUT_CODE } from './exec.js';
import { scratchDir } from './test-helpers/fixtures.js';

const exec = createNodeExec();
const node = process.execPath;

describe('exitCodeOf', () => {
  it('maps every error shape to a number', () => {
    expect(exitCodeOf(null)).toBe(0);
    expect(exitCodeOf(Object.assign(new Error('x'), { code: 5 }))).toBe(5);
    expect(exitCodeOf(Object.assign(new Error('x'), { killed: true, code: null }))).toBe(124);
    expect(exitCodeOf(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(127);
    expect(exitCodeOf(Object.assign(new Error('x'), { killed: false }))).toBe(1);
    expect(NOT_FOUND_CODE).toBe(127);
    expect(TIMEOUT_CODE).toBe(124);
  });
});

describe('createNodeExec', () => {
  it('returns exit code, stdout and stderr', async () => {
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";
    const result = await exec(node, ['-e', script], {});
    expect(result).toStrictEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('succeeds with code 0', async () => {
    const result = await exec(node, ['-e', "process.stdout.write('ok')"], {});
    expect(result).toStrictEqual({ code: 0, stdout: 'ok', stderr: '' });
  });

  it('passes arguments without a shell', async () => {
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const result = await exec(node, ['-e', script, '$HOME', 'a b', ';ls'], {});
    expect(JSON.parse(result.stdout)).toStrictEqual(['$HOME', 'a b', ';ls']);
  });

  it('uses the error message when a failure printed nothing', async () => {
    const result = await exec(node, ['-e', 'process.exit(2)'], {});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Command failed');
  });

  it('reports a missing program as 127', async () => {
    const result = await exec('overlord-no-such-program', [], {});
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stdout).toBe('');
  });

  it('kills a program that runs past its timeout', async () => {
    const result = await exec(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });
    expect(result.code).toBe(124);
  });

  it('reports a signal death as 1', async () => {
    const result = await exec(node, ['-e', "process.kill(process.pid, 'SIGKILL')"], {});
    expect(result.code).toBe(1);
  });

  it('runs in cwd and layers env over the parent environment', async () => {
    const dir = await scratchDir();
    const script =
      'process.stdout.write([process.cwd(), process.env.OVERLORD_X, typeof process.env.PATH].join("|"))';
    const result = await exec(node, ['-e', script], { cwd: dir, env: { OVERLORD_X: 'yes' } });
    expect(result.stdout).toBe(`${dir}|yes|string`);
  });

  it('keeps large output', async () => {
    const result = await exec(node, ['-e', "process.stdout.write('x'.repeat(2000000))"], {});
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(2_000_000);
  });
});
