import os from 'node:os';

import { describe, expect, it } from 'vitest';

import type { FileSystem } from '../context/fs.js';
import { createMemoryFs } from '../context/test-helpers/memory-fs.js';
import type { ExecResult } from '../sync/exec.js';

import type { ProcessRow } from './process-table.js';
import type { SampleDeps, Space } from './sample.js';
import { defaultStatfs, NOTES, Sampler, STATFS_TIMEOUT_MS } from './sample.js';

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

type Answers = Readonly<Record<string, ExecResult>>;

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '' };
}

function failed(code = 1): ExecResult {
  return { code, stdout: '', stderr: 'no' };
}

interface Setup {
  readonly platform: NodeJS.Platform;
  readonly answers?: Answers;
  readonly fs?: FileSystem;
  readonly statfs?: (target: string) => Promise<Space>;
  readonly delay?: (ms: number) => Promise<void>;
  readonly loadavg?: readonly number[];
}

async function never(): Promise<void> {
  await new Promise<void>(() => {
    // Never settles, like a timer that has not fired yet.
  });
}

async function someSpace(): Promise<Space> {
  await Promise.resolve();
  return { freeBytes: 10, totalBytes: 100 };
}

function make(setup: Setup): { sampler: Sampler; calls: Call[] } {
  const calls: Call[] = [];
  const deps: SampleDeps = {
    platform: setup.platform,
    exec: async (command, args) => {
      calls.push({ command, args });
      await Promise.resolve();
      return setup.answers?.[`${command} ${args[0] ?? ''}`] ?? setup.answers?.[command] ?? failed();
    },
    fs: setup.fs ?? createMemoryFs({ files: {} }),
    clock: () => 1234,
    machine: {
      cpus: () => [{ times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } }],
      loadavg: () => setup.loadavg ?? [1.5, 1, 0.5],
      totalmem: () => 1_000_000,
    },
    statfs: setup.statfs ?? someSpace,
    delay: setup.delay ?? never,
  };
  return { sampler: new Sampler(deps), calls };
}

const all = (rows: readonly ProcessRow[]): number[] => rows.map((row) => row.pid);

const PS = ok(' 10 1 S 100 0:01.00 claude\n 11 10 R 200 0:02.00 node\n');

const DARWIN: Answers = {
  ps: PS,
  'xcode-select': ok('/Library/Developer/CommandLineTools\n'),
  '/usr/bin/python3': ok('10 5 6\n11 7 8\n'),
  nettop: ok(',bytes_in,bytes_out,\nclaude.10,1,2,\n'),
  vm_stat: ok('Mach Virtual Memory Statistics: (page size of 1000 bytes)\nPages free: 100.\n'),
  sysctl: ok('1\n'),
  pmset: ok('Note: none\n'),
};

describe('Sampler on macOS', () => {
  it('reads ps, command lines, disk, network and machine numbers', async () => {
    const { sampler, calls } = make({ platform: 'darwin', answers: DARWIN });
    const sample = await sampler.read(all, ['/w', '/w']);
    expect(sample.at).toBe(1234);
    expect(sample.rows.map((row) => row.name)).toStrictEqual(['claude', 'node']);
    expect(sample.args.get(10)).toBe('1 S 100 0:01.00 claude');
    expect([...(sample.disk ?? [])]).toStrictEqual([
      ['10', { pid: 10, read: 5, write: 6 }],
      ['11', { pid: 11, read: 7, write: 8 }],
    ]);
    expect([...(sample.network ?? [])]).toStrictEqual([['10', { pid: 10, read: 1, write: 2 }]]);
    expect(sample.cores).toBe(1);
    expect(sample.cpu).toStrictEqual({ busy: 20, total: 100 });
    expect(sample.loadAverage).toStrictEqual([1.5, 1, 0.5]);
    expect(sample.memory.usedBytes).toBe(900_000);
    expect(sample.memoryPressure).toBe('normal');
    expect(sample.stall).toBeNull();
    expect(sample.cpuSpeedLimitPct).toBe(100);
    expect(sample.volumes).toStrictEqual([
      { path: '/w', freeBytes: 10, totalBytes: 100, responding: true },
    ]);
    expect(sample.wchan.size).toBe(0);
    expect(sampler.notes).toStrictEqual([]);
    expect(calls.find((call) => call.command === '/usr/bin/python3')?.args.slice(-2)).toStrictEqual(
      ['10', '11'],
    );
    expect(
      calls.find((call) => call.command === 'ps' && call.args[0] === '-o')?.args,
    ).toStrictEqual(['-o', 'pid=,args=', '-p', '10,11']);
  });

  it('skips per process reads when no session runs', async () => {
    const { sampler, calls } = make({ platform: 'darwin', answers: DARWIN });
    const sample = await sampler.read(() => [], []);
    expect(sample.args.size).toBe(0);
    expect(sample.disk?.size).toBe(0);
    expect(sample.volumes).toStrictEqual([]);
    expect(calls.some((call) => call.command === '/usr/bin/python3')).toBe(false);
  });

  it('notes what it cannot read and checks for python only once', async () => {
    const { sampler, calls } = make({
      platform: 'darwin',
      answers: { ps: PS },
    });
    const sample = await sampler.read(all, []);
    await sampler.read(all, []);
    expect(sample.disk).toBeNull();
    expect(sample.network).toBeNull();
    expect(sample.memory).toStrictEqual({
      usedBytes: null,
      swapTotalBytes: null,
      swapUsedBytes: null,
    });
    expect(sample.memoryPressure).toBeNull();
    expect(sample.cpuSpeedLimitPct).toBeNull();
    expect(sampler.notes).toStrictEqual([NOTES.nettop, NOTES.python]);
    expect(calls.filter((call) => call.command === 'xcode-select')).toHaveLength(1);
  });

  it('gives no disk numbers when the script fails and no rows when ps fails', async () => {
    const answers = { ...DARWIN, '/usr/bin/python3': failed() };
    const { sampler } = make({ platform: 'darwin', answers });
    const noScript = await sampler.read(all, []);
    expect(noScript.disk).toBeNull();
    const broken = make({ platform: 'darwin', answers: { ...DARWIN, ps: failed() } });
    const noPs = await broken.sampler.read(all, []);
    expect(noPs.rows).toStrictEqual([]);
    const noArgs = make({ platform: 'darwin', answers: { ...DARWIN, 'ps -o': failed() } });
    const sample = await noArgs.sampler.read(all, []);
    expect(sample.rows).toHaveLength(2);
    expect(sample.args.size).toBe(0);
  });
});

const STAT = (pid: number, ppid: number, state: string): string =>
  `${String(pid)} (proc${String(pid)}) ${state} ${String(ppid)} 0 0 0 0 0 0 0 0 0 100 100 0 0 20 0 1 0 1 1 3`;

const LINUX_FILES: Readonly<Record<string, string>> = {
  '/proc/10/stat': STAT(10, 1, 'S'),
  '/proc/11/stat': STAT(11, 10, 'D'),
  '/proc/12/stat': STAT(12, 10, 'D'),
  '/proc/13/stat': STAT(13, 10, 'D'),
  '/proc/10/cmdline': 'claude\0--resume\0',
  '/proc/11/cmdline': '',
  '/proc/10/io': 'read_bytes: 10\nwrite_bytes: 20\n',
  '/proc/11/io': 'rchar: 1\n',
  '/proc/11/wchan': 'io_schedule\n',
  '/proc/12/wchan': '0',
  '/proc/meminfo': 'MemTotal: 100 kB\nMemAvailable: 40 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
  '/proc/pressure/io': 'some avg10=30.00 avg60=1 avg300=1 total=1\n',
};

describe('Sampler on Linux', () => {
  it('reads /proc, ss and the pressure files', async () => {
    const { sampler, calls } = make({
      platform: 'linux',
      fs: createMemoryFs({ files: LINUX_FILES, dirs: ['/proc/self'] }),
      answers: {
        getconf: ok('50\n'),
        ss: ok(
          'ESTAB 0 0 a:1 b:2 users:(("claude",pid=10,fd=3))\n\t bytes_acked:5 bytes_received:6\n',
        ),
      },
    });
    const sample = await sampler.read(all, []);
    await sampler.read(all, []);
    expect(sample.rows.map((row) => [row.pid, row.cpuMs, row.rssBytes])).toStrictEqual([
      [10, 4000, 150],
      [11, 4000, 150],
      [12, 4000, 150],
      [13, 4000, 150],
    ]);
    expect([...sample.args]).toStrictEqual([[10, 'claude --resume']]);
    expect([...(sample.disk ?? [])]).toStrictEqual([['10', { pid: 10, read: 10, write: 20 }]]);
    expect([...(sample.network ?? [])]).toStrictEqual([
      ['a:1 b:2', { pid: 10, read: 6, write: 5 }],
    ]);
    expect([...sample.wchan]).toStrictEqual([[11, 'io_schedule']]);
    expect(sample.memory.usedBytes).toBe(60 * 1024);
    expect(sample.stall).toStrictEqual({ cpu: null, memory: null, io: 30 });
    expect(sample.memoryPressure).toBeNull();
    expect(sample.cpuSpeedLimitPct).toBeNull();
    expect(sampler.notes).toStrictEqual([NOTES.tcpOnly]);
    expect(calls.filter((call) => call.command === 'getconf')).toHaveLength(2);
  });

  it('falls back to default units and notes a missing ss', async () => {
    const { sampler } = make({
      platform: 'linux',
      fs: createMemoryFs({ files: { '/proc/10/stat': STAT(10, 1, 'S') } }),
      answers: { getconf: ok('junk'), ss: failed(127) },
    });
    const sample = await sampler.read(all, []);
    expect(sample.rows[0]?.cpuMs).toBe(2000);
    expect(sample.rows[0]?.rssBytes).toBe(3 * 4096);
    expect(sample.network).toBeNull();
    expect(sample.memory.usedBytes).toBeNull();
    expect(sample.stall).toBeNull();
    expect(sampler.notes).toStrictEqual([NOTES.tcpOnly, NOTES.ss]);
  });

  it('gives no network numbers when ss fails for another reason', async () => {
    const { sampler } = make({ platform: 'linux', answers: { ss: failed(2) } });
    const sample = await sampler.read(all, []);
    expect(sample.network).toBeNull();
    expect(sampler.notes).toStrictEqual([NOTES.tcpOnly]);
  });
});

describe('Sampler elsewhere', () => {
  it('notes that the platform is not measured', async () => {
    const { sampler, calls } = make({ platform: 'win32', loadavg: [] });
    const sample = await sampler.read(() => [5], []);
    expect(sample.loadAverage).toStrictEqual([0, 0, 0]);
    expect(sample.rows).toStrictEqual([]);
    expect(sample.disk).toBeNull();
    expect(sample.network).toBeNull();
    expect(sample.wchan.size).toBe(0);
    expect(sample.memory.usedBytes).toBeNull();
    expect(sampler.notes).toStrictEqual([NOTES.unsupported]);
    expect(calls).toStrictEqual([]);
  });
});

describe('volumes', () => {
  it('drops folders on a volume already listed and ones statfs cannot read', async () => {
    const spaces: Readonly<Record<string, Space>> = {
      '/a': { freeBytes: 1, totalBytes: 10 },
      '/b': { freeBytes: 1, totalBytes: 10 },
      '/c': { freeBytes: 2, totalBytes: 20 },
    };
    const { sampler } = make({
      platform: 'win32',
      statfs: async (target) => {
        await Promise.resolve();
        const space = spaces[target];
        if (space === undefined) {
          throw new Error('gone');
        }
        return space;
      },
    });
    const sample = await sampler.read(() => [], ['/a', '/b', '/c', '/missing']);
    expect(sample.volumes.map((volume) => volume.path)).toStrictEqual(['/a', '/c']);
  });

  it('marks a hung filesystem and does not call it again until it answers', async () => {
    const holder: { release: ((space: Space) => void) | null } = { release: null };
    let statfsCalls = 0;
    const { sampler } = make({
      platform: 'win32',
      statfs: async () => {
        statfsCalls += 1;
        return new Promise<Space>((resolve) => {
          holder.release = resolve;
        });
      },
      delay: async (ms) => {
        expect(ms).toBe(STATFS_TIMEOUT_MS);
        await Promise.resolve();
      },
    });
    const hung = { path: '/nfs', freeBytes: null, totalBytes: null, responding: false };
    const first = await sampler.read(() => [], ['/nfs']);
    const second = await sampler.read(() => [], ['/nfs']);
    expect(first.volumes).toStrictEqual([hung]);
    expect(second.volumes).toStrictEqual([hung]);
    expect(statfsCalls).toBe(1);
    holder.release?.({ freeBytes: 5, totalBytes: 50 });
    await Promise.resolve();
    await Promise.resolve();
    await sampler.read(() => [], ['/nfs']);
    expect(statfsCalls).toBe(2);
  });

  it('frees a folder whose statfs failed after the time limit', async () => {
    const holder: { fail: ((error: Error) => void) | null } = { fail: null };
    let statfsCalls = 0;
    const { sampler } = make({
      platform: 'win32',
      statfs: async () => {
        statfsCalls += 1;
        return new Promise<Space>((_resolve, reject) => {
          holder.fail = reject;
        });
      },
      delay: async () => {
        await Promise.resolve();
      },
    });
    await sampler.read(() => [], ['/nfs']);
    holder.fail?.(new Error('stale handle'));
    await Promise.resolve();
    await Promise.resolve();
    await sampler.read(() => [], ['/nfs']);
    expect(statfsCalls).toBe(2);
  });

  it('reads real space with statfs', async () => {
    const space = await defaultStatfs(os.tmpdir());
    expect(space.totalBytes).toBeGreaterThan(0);
    expect(space.freeBytes).toBeGreaterThanOrEqual(0);
  });
});
