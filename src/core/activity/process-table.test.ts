import { describe, expect, it } from 'vitest';

import { createMemoryFs } from '../context/test-helpers/memory-fs.js';

import type { ProcessRow } from './process-table.js';
import {
  DEFAULT_LINUX_UNITS,
  descendants,
  parseArgs,
  parseCmdline,
  parseCpuTime,
  parseDarwinPs,
  parseProcStat,
  readLinuxProcesses,
} from './process-table.js';

function row(pid: number, ppid: number): ProcessRow {
  return { pid, ppid, state: 'S', rssBytes: 0, cpuMs: 0, name: `p${String(pid)}` };
}

function pids(rows: readonly ProcessRow[]): number[] {
  return rows.map((entry) => entry.pid);
}

describe('parseCpuTime', () => {
  it('reads minutes and seconds, hours, and days', () => {
    expect(parseCpuTime('0:01.50')).toBe(1500);
    expect(parseCpuTime('555:44.04')).toBeCloseTo(33_344_040);
    expect(parseCpuTime('01:02:03')).toBe(3_723_000);
    expect(parseCpuTime('2-00:00:01')).toBe(172_801_000);
  });

  it('gives NaN for anything else', () => {
    expect(parseCpuTime('12')).toBeNaN();
    expect(parseCpuTime('1:2:3:4')).toBeNaN();
    expect(parseCpuTime('1:' + ':2')).toBeNaN();
    expect(parseCpuTime('a:b')).toBeNaN();
  });
});

describe('parseDarwinPs', () => {
  it('reads each row and keeps names with spaces', () => {
    const out = [
      '    1     0 Ss    20544  40:03.16 /sbin/launchd',
      ' 5011  4993 SNs+  1024   0:01.00 claude bg-spare',
      '  700     1 R      512   0:00.50 /Applications/My App.app/Contents/MacOS/My App',
      'garbage',
      '  800     1 S      512   bad /bin/x',
      '',
    ].join('\n');
    expect(parseDarwinPs(out)).toStrictEqual([
      { pid: 1, ppid: 0, state: 'Ss', rssBytes: 20_544 * 1024, cpuMs: 2_403_160, name: 'launchd' },
      {
        pid: 5011,
        ppid: 4993,
        state: 'SNs+',
        rssBytes: 1024 * 1024,
        cpuMs: 1000,
        name: 'claude bg-spare',
      },
      { pid: 700, ppid: 1, state: 'R', rssBytes: 512 * 1024, cpuMs: 500, name: 'My App' },
    ]);
  });
});

describe('parseProcStat', () => {
  const units = { ticksPerSecond: 100, pageBytes: 4096 };
  const tail = '1 2 3 4 5 6 7 8 9 150 50 0 0 20 0 4 0 99 1000 300';

  it('reads state, parent, CPU ticks and resident pages', () => {
    expect(parseProcStat(42, `42 (node) R 7 ${tail}`, units)).toStrictEqual({
      pid: 42,
      ppid: 7,
      state: 'R',
      rssBytes: 300 * 4096,
      cpuMs: 2000,
      name: 'node',
    });
  });

  it('keeps a name that holds spaces and parentheses', () => {
    expect(parseProcStat(9, `9 (a (b) c) D 1 ${tail}`, units)?.name).toBe('a (b) c');
  });

  it('gives null for a line it cannot read', () => {
    expect(parseProcStat(1, 'no parens here', units)).toBeNull();
    expect(parseProcStat(1, '1 ) broken (', units)).toBeNull();
    expect(parseProcStat(1, '1 (short) S 0 1 2', units)).toBeNull();
  });
});

describe('readLinuxProcesses', () => {
  it('reads every numeric /proc entry and skips ones that vanished', async () => {
    const fs = createMemoryFs({
      files: {
        '/proc/1/stat': `1 (init) S 0 ${'0 '.repeat(9)}10 10 0 0 20 0 1 0 1 1 5`,
        '/proc/meminfo': '',
      },
      dirs: ['/proc/2', '/proc/self'],
    });
    const rows = await readLinuxProcesses(fs, DEFAULT_LINUX_UNITS);
    expect(rows).toStrictEqual([
      { pid: 1, ppid: 0, state: 'S', rssBytes: 5 * 4096, cpuMs: 200, name: 'init' },
    ]);
  });
});

describe('command lines', () => {
  it('joins a NUL separated cmdline', () => {
    expect(parseCmdline('node\0server.js\0--port\0\0')).toBe('node server.js --port');
  });

  it('reads ps pid and args pairs', () => {
    expect([...parseArgs('  12 node a b \n  13 sh\nnope\n')]).toStrictEqual([
      [12, 'node a b'],
      [13, 'sh'],
    ]);
  });
});

describe('descendants', () => {
  it('walks the tree breadth first from the root', () => {
    const rows = [row(1, 0), row(10, 1), row(11, 1), row(20, 10), row(30, 99)];
    expect(pids(descendants(row(1, 0), rows))).toStrictEqual([1, 10, 11, 20]);
  });

  it('leaves out subtrees under a stop pid and ignores self parents', () => {
    const rows = [row(1, 0), row(10, 1), row(11, 1), row(20, 10), row(0, 0)];
    expect(pids(descendants(row(1, 0), rows, new Set([10])))).toStrictEqual([1, 11]);
    expect(pids(descendants(row(0, 0), rows))).toStrictEqual([0, 1, 10, 11, 20]);
  });
});
