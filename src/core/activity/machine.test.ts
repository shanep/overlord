import { describe, expect, it } from 'vitest';

import type { CoreTimes } from './machine.js';
import {
  labeledNumbers,
  machineCpuPct,
  parseMeminfo,
  parsePressureLevel,
  parseSpeedLimit,
  parseStall,
  parseSwapUsage,
  parseVmStat,
  stallFrom,
  sumCpuTimes,
} from './machine.js';

describe('labeledNumbers', () => {
  it('reads label: number lines and skips the rest', () => {
    expect([
      ...labeledNumbers('Pages free:   10.\nMemTotal: 5 kB\nno colon\n: 4\nName: x\n'),
    ]).toStrictEqual([
      ['Pages free', 10],
      ['MemTotal', 5],
    ]);
  });
});

describe('parseVmStat', () => {
  const out = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                    100.',
    'Pages active:                                 5000.',
    'Pages inactive:                                200.',
    'Pages speculative:                              50.',
  ].join('\n');

  it('counts all but free, inactive and speculative pages as used', () => {
    expect(parseVmStat(out, 1_000_000_000)).toBe(1_000_000_000 - 350 * 16_384);
  });

  it('never goes below 0 and gives null without a page size', () => {
    expect(parseVmStat(out, 0)).toBe(0);
    expect(parseVmStat('Pages free: 1.', 100)).toBeNull();
  });
});

describe('swap and meminfo', () => {
  it('reads macOS swap usage', () => {
    expect(
      parseSwapUsage('total = 2048.00M  used = 512.50M  free = 1535.50M  (encrypted)'),
    ).toStrictEqual({
      swapTotalBytes: 2048 * 1024 * 1024,
      swapUsedBytes: 512.5 * 1024 * 1024,
    });
    expect(parseSwapUsage('')).toStrictEqual({ swapTotalBytes: null, swapUsedBytes: null });
  });

  it('reads /proc/meminfo', () => {
    const text =
      'MemTotal: 1000 kB\nMemFree: 10 kB\nMemAvailable: 600 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n';
    expect(parseMeminfo(text)).toStrictEqual({
      usedBytes: 400 * 1024,
      swapTotalBytes: 200 * 1024,
      swapUsedBytes: 50 * 1024,
    });
    expect(parseMeminfo('MemTotal: 1000 kB\n')).toStrictEqual({
      usedBytes: null,
      swapTotalBytes: null,
      swapUsedBytes: null,
    });
  });
});

describe('pressure', () => {
  it('maps the macOS pressure level', () => {
    expect(parsePressureLevel('1\n')).toBe('normal');
    expect(parsePressureLevel('2')).toBe('warning');
    expect(parsePressureLevel('4')).toBe('critical');
    expect(parsePressureLevel('')).toBeNull();
  });

  it('reads the some avg10 figure from a PSI file', () => {
    const text =
      'some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=1.00 avg60=0 avg300=0 total=1\n';
    expect(parseStall(text)).toBe(12.5);
    expect(parseStall('full avg10=1.00')).toBeNull();
    expect(parseStall(null)).toBeNull();
  });

  it('gives null when no PSI file was there', () => {
    expect(stallFrom(null, null, null)).toBeNull();
    expect(stallFrom('some avg10=1.00', null, 'some avg10=2.00')).toStrictEqual({
      cpu: 1,
      memory: null,
      io: 2,
    });
  });

  it('reads the CPU speed limit and treats no line as full speed', () => {
    expect(parseSpeedLimit('CPU_Scheduler_Limit = 100\nCPU_Speed_Limit = 70\n')).toBe(70);
    expect(parseSpeedLimit('Note: No CPU power status has been recorded')).toBe(100);
  });
});

function core(user: number, idle: number): CoreTimes {
  return { times: { user, nice: 0, sys: 0, idle, irq: 0 } };
}

describe('machine CPU', () => {
  it('sums busy and total time over cores', () => {
    expect(sumCpuTimes([core(10, 90), core(30, 70)])).toStrictEqual({ busy: 40, total: 200 });
  });

  it('gives the busy share between two readings', () => {
    expect(machineCpuPct({ busy: 40, total: 200 }, { busy: 140, total: 400 })).toBe(50);
    expect(machineCpuPct({ busy: 40, total: 200 }, { busy: 40, total: 200 })).toBeNull();
    expect(machineCpuPct({ busy: 0, total: 0 }, { busy: 500, total: 100 })).toBe(100);
  });
});
