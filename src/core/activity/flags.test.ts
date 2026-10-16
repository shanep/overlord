import { describe, expect, it } from 'vitest';

import type { ActivityAlert, MachineActivity } from '../../shared/activity.js';

import type { MachineContext, ProcessSnapshot } from './flags.js';
import { formatBytes, HISTORY, machineAlerts, processFlags, sortAlerts } from './flags.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

const CALM: MachineContext = { cores: 8, cpuPct: 20, load1: 2, memoryTotalBytes: 16 * GB };

function snap(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    state: 'S',
    cpuPct: 1,
    memoryBytes: 100 * MB,
    diskPerSec: 0,
    networkPerSec: 0,
    ...overrides,
  };
}

function full(overrides: Partial<ProcessSnapshot>): ProcessSnapshot[] {
  return Array.from({ length: HISTORY }, () => snap(overrides));
}

function kinds(
  history: readonly ProcessSnapshot[],
  machine = CALM,
  wchan: string | null = null,
): string[] {
  return processFlags(history, machine, 2000, wchan).map((flag) => `${flag.kind}:${flag.level}`);
}

describe('formatBytes', () => {
  it('uses MB below a gigabyte and GB above', () => {
    expect(formatBytes(50 * MB)).toBe('50 MB');
    expect(formatBytes(1.5 * GB)).toBe('1.5 GB');
  });
});

describe('processFlags', () => {
  it('raises nothing for a quiet process or an empty history', () => {
    expect(kinds(full({}))).toStrictEqual([]);
    expect(kinds([])).toStrictEqual([]);
  });

  it('flags a blocked process after two samples and escalates after a full window', () => {
    expect(kinds([snap({ state: 'D' })])).toStrictEqual([]);
    expect(kinds([snap(), snap({ state: 'U' }), snap({ state: 'D+' })])).toStrictEqual([
      'blocked:warning',
    ]);
    expect(kinds(full({ state: 'D' }))).toStrictEqual(['blocked:critical']);
    const [flag] = processFlags(full({ state: 'D' }), CALM, 2000, 'nfs_wait_on_request');
    expect(flag?.detail).toBe(
      'In an uninterruptible wait for 10s, which nearly always means waiting on the disk or a network filesystem. The kernel shows it waiting in nfs_wait_on_request.',
    );
  });

  it('flags zombies and stopped processes', () => {
    expect(kinds([snap({ state: 'Z' })])).toStrictEqual(['zombie:warning']);
    expect(kinds([snap({ state: 'T+' })])).toStrictEqual(['stopped:warning']);
    expect(kinds([snap({ state: 't' })])).toStrictEqual(['stopped:warning']);
  });

  it('flags a CPU hog over a full window, critical when the machine is full', () => {
    expect(kinds(full({ cpuPct: 150 }))).toStrictEqual(['cpu-hog:warning']);
    expect(kinds(full({ cpuPct: 150 }), { ...CALM, cpuPct: 95 })).toStrictEqual([
      'cpu-hog:critical',
    ]);
    expect(kinds(full({ cpuPct: 150 }).slice(1))).toStrictEqual([]);
    expect(kinds([...full({ cpuPct: 150 }).slice(1), snap({ cpuPct: null })])).toStrictEqual([]);
    const [flag] = processFlags(full({ cpuPct: 150 }), { ...CALM, cpuPct: 95 }, 2000, null);
    expect(flag?.detail).toBe(
      'Used 150% CPU (1.5 cores) for the last 10s while the machine is nearly full.',
    );
  });

  it('flags a memory hog by its share of memory', () => {
    expect(kinds([snap({ memoryBytes: 2 * GB })])).toStrictEqual(['memory-hog:warning']);
    expect(kinds([snap({ memoryBytes: 5 * GB })])).toStrictEqual(['memory-hog:critical']);
    expect(kinds([snap({ memoryBytes: 5 * GB })], { ...CALM, memoryTotalBytes: 0 })).toStrictEqual(
      [],
    );
  });

  it('flags disk and network hogs', () => {
    expect(kinds(full({ diskPerSec: 80 * MB }))).toStrictEqual(['disk-hog:warning']);
    expect(kinds(full({ networkPerSec: 30 * MB }))).toStrictEqual(['network-hog:warning']);
    expect(kinds(full({ diskPerSec: null, networkPerSec: null }))).toStrictEqual([]);
  });

  it('flags a runnable process starved of CPU on an overloaded machine', () => {
    const overloaded = { ...CALM, load1: 20 };
    expect(kinds(full({ state: 'R', cpuPct: 5 }), overloaded)).toStrictEqual(['starved:warning']);
    expect(kinds(full({ state: 'R', cpuPct: 5 }))).toStrictEqual([]);
    expect(kinds(full({ state: 'R', cpuPct: 50 }), overloaded)).toStrictEqual([]);
    expect(kinds([snap(), ...full({ state: 'R', cpuPct: 5 }).slice(1)], overloaded)).toStrictEqual(
      [],
    );
    expect(kinds(full({ state: 'R', cpuPct: 5 }), { ...overloaded, cores: 0 })).toStrictEqual([]);
    const [flag] = processFlags(full({ state: 'R', cpuPct: 5 }), overloaded, 2000, null);
    expect(flag?.detail).toBe(
      'Ready to run for the last 10s but got only 5% CPU, because load is 20.0 on 8 cores.',
    );
  });
});

const MACHINE: MachineActivity = {
  cores: 8,
  cpuPct: 10,
  loadAverage: [1, 1, 1],
  memoryTotalBytes: 16 * GB,
  memoryUsedBytes: 4 * GB,
  swapUsedBytes: 0,
  swapTotalBytes: 0,
  memoryPressure: 'normal',
  stall: null,
  cpuSpeedLimitPct: 100,
  volumes: [],
};

function messages(machine: Partial<MachineActivity>): string[] {
  return machineAlerts({ ...MACHINE, ...machine }).map(
    (alert) => `${alert.level}: ${alert.message}`,
  );
}

describe('machineAlerts', () => {
  it('stays quiet for a calm machine', () => {
    expect(messages({})).toStrictEqual([]);
    expect(
      messages({ memoryPressure: null, cpuSpeedLimitPct: null, swapTotalBytes: null }),
    ).toStrictEqual([]);
  });

  it('grades load per core', () => {
    expect(messages({ loadAverage: [10, 1, 1] })).toStrictEqual([
      'warning: Load is 10.0 on 8 cores, so ready processes queue for CPU.',
    ]);
    expect(messages({ loadAverage: [97.3, 1, 1] })).toStrictEqual([
      'critical: Load is 97.3 on 8 cores, so ready processes queue for CPU.',
    ]);
    expect(messages({ loadAverage: [3, 1, 1], cores: 0 })).toStrictEqual([
      'critical: Load is 3.0 on 0 cores, so ready processes queue for CPU.',
    ]);
  });

  it('passes on memory pressure, full swap and a slowed CPU', () => {
    expect(messages({ memoryPressure: 'critical' })).toStrictEqual([
      'critical: macOS reports memory pressure as critical, so it is compressing memory and swapping.',
    ]);
    expect(messages({ memoryPressure: 'warning' })).toHaveLength(1);
    expect(messages({ swapUsedBytes: 9 * GB, swapTotalBytes: 10 * GB })).toStrictEqual([
      'warning: Swap is 90% full.',
    ]);
    expect(messages({ swapUsedBytes: GB, swapTotalBytes: 10 * GB })).toStrictEqual([]);
    expect(messages({ cpuSpeedLimitPct: 70 })).toStrictEqual([
      'warning: macOS has slowed the CPU to 70% of its speed for heat or power.',
    ]);
    expect(messages({ cpuSpeedLimitPct: 40 })[0]).toMatch(/^critical/u);
  });

  it('grades pressure stalls', () => {
    expect(messages({ stall: { cpu: 60, memory: 35, io: 25 } })).toStrictEqual([
      'warning: Tasks waited for CPU 60% of the last 10 seconds.',
      'critical: Tasks waited on memory 35% of the last 10 seconds.',
      'warning: Tasks waited on disk I/O 25% of the last 10 seconds.',
    ]);
    expect(messages({ stall: { cpu: null, memory: 1, io: 60 } })).toStrictEqual([
      'critical: Tasks waited on disk I/O 60% of the last 10 seconds.',
    ]);
  });

  it('warns about full and hung volumes', () => {
    const volume = { path: '/w', responding: true };
    expect(
      messages({
        volumes: [
          { ...volume, path: '/hung', freeBytes: null, totalBytes: null, responding: false },
          { ...volume, path: '/full', freeBytes: GB, totalBytes: 1000 * GB },
          { ...volume, path: '/low', freeBytes: 80 * GB, totalBytes: 1000 * GB },
          { ...volume, path: '/ok', freeBytes: 500 * GB, totalBytes: 1000 * GB },
          { ...volume, path: '/odd', freeBytes: null, totalBytes: 0 },
          { ...volume, path: '/zero', freeBytes: 0, totalBytes: 0 },
        ],
      }),
    ).toStrictEqual([
      'critical: The filesystem holding /hung did not answer, so anything reading it will hang.',
      'critical: Only 1.0 GB free on the disk holding /full.',
      'warning: Only 80.0 GB free on the disk holding /low.',
    ]);
  });
});

function makeAlert(level: ActivityAlert['level'], subject: string): ActivityAlert {
  return { level, sessionId: null, pid: null, subject, message: '' };
}

describe('sortAlerts', () => {
  it('puts critical first and keeps the order otherwise', () => {
    const sorted = sortAlerts([
      makeAlert('warning', 'a'),
      makeAlert('critical', 'b'),
      makeAlert('warning', 'c'),
      makeAlert('critical', 'd'),
    ]);
    expect(sorted.map((entry) => entry.subject)).toStrictEqual(['b', 'd', 'a', 'c']);
  });
});
