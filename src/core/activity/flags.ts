// Spots processes that hog, starve or are stuck, and machine wide trouble.
// A process is judged on its last few samples, so a short burst does not
// raise a flag but ten seconds of it does.

import type {
  ActivityAlert,
  ActivityLevel,
  MachineActivity,
  ProcessFlag,
} from '../../shared/activity.js';

/** Samples kept per process. At one sample every two seconds that is ten seconds. */
export const HISTORY = 5;

export interface ProcessSnapshot {
  readonly state: string;
  readonly cpuPct: number | null;
  readonly memoryBytes: number;
  /** Read plus write, null when unknown. */
  readonly diskPerSec: number | null;
  readonly networkPerSec: number | null;
}

export interface MachineContext {
  readonly cores: number;
  readonly cpuPct: number | null;
  readonly load1: number;
  readonly memoryTotalBytes: number;
}

const CPU_HOG_PCT = 90;
const BUSY_MACHINE_PCT = 90;
const MEMORY_WARN_SHARE = 0.1;
const MEMORY_CRITICAL_SHARE = 0.25;
const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * MEGABYTE;
const DISK_HOG_PER_SEC = 50 * MEGABYTE;
const NETWORK_HOG_PER_SEC = 25 * MEGABYTE;
const STARVED_CPU_PCT = 25;
const STARVED_LOAD_PER_CORE = 1.5;
const BLOCKED_SAMPLES = 2;

export function formatBytes(bytes: number): string {
  if (bytes >= GIGABYTE) {
    return `${(bytes / GIGABYTE).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / MEGABYTE).toString()} MB`;
}

function round(value: number): string {
  return Math.round(value).toString();
}

/** How many of the newest samples in a row pass the test. */
function trailing(
  history: readonly ProcessSnapshot[],
  test: (s: ProcessSnapshot) => boolean,
): number {
  const index = history.findLastIndex((snapshot) => !test(snapshot));
  return history.length - 1 - index;
}

/** The mean over a full window, or null while the window is short or any sample is unknown. */
function windowMean(
  history: readonly ProcessSnapshot[],
  pick: (s: ProcessSnapshot) => number | null,
): number | null {
  if (history.length < HISTORY) {
    return null;
  }
  let sum = 0;
  for (const snapshot of history.slice(-HISTORY)) {
    const value = pick(snapshot);
    if (value === null) {
      return null;
    }
    sum += value;
  }
  return sum / HISTORY;
}

function stateFlags(
  history: readonly ProcessSnapshot[],
  seconds: (samples: number) => number,
  wchan: string | null,
): ProcessFlag[] {
  const flags: ProcessFlag[] = [];
  const letter = history.at(-1)?.state.charAt(0) ?? '';
  const blocked = trailing(history, (s) => /^[DU]/u.test(s.state));
  if (blocked >= BLOCKED_SAMPLES) {
    const where = wchan === null ? '' : ` The kernel shows it waiting in ${wchan}.`;
    flags.push({
      kind: 'blocked',
      level: blocked >= HISTORY ? 'critical' : 'warning',
      detail: `In an uninterruptible wait for ${round(seconds(blocked))}s, which nearly always means waiting on the disk or a network filesystem.${where}`,
    });
  }
  if (letter === 'Z') {
    flags.push({
      kind: 'zombie',
      level: 'warning',
      detail: 'Exited, but its parent has not collected its exit status.',
    });
  }
  if (letter === 'T' || letter === 't') {
    flags.push({
      kind: 'stopped',
      level: 'warning',
      detail: 'Stopped by a signal, such as Ctrl+Z or a debugger, so it makes no progress.',
    });
  }
  return flags;
}

/** What the usage checks look at: the samples, the machine, the window in seconds and the mean CPU. */
interface Window {
  readonly history: readonly ProcessSnapshot[];
  readonly machine: MachineContext;
  readonly seconds: number;
  readonly cpu: number | null;
}

function cpuHog(window: Window): ProcessFlag | null {
  const { cpu, machine } = window;
  if (cpu === null || cpu < CPU_HOG_PCT) {
    return null;
  }
  const busy = machine.cpuPct !== null && machine.cpuPct >= BUSY_MACHINE_PCT;
  return {
    kind: 'cpu-hog',
    level: busy ? 'critical' : 'warning',
    detail: `Used ${round(cpu)}% CPU (${(cpu / 100).toFixed(1)} cores) for the last ${round(window.seconds)}s${busy ? ' while the machine is nearly full' : ''}.`,
  };
}

function memoryHog(window: Window): ProcessFlag | null {
  const memory = window.history.at(-1)?.memoryBytes ?? 0;
  const total = window.machine.memoryTotalBytes;
  const share = total > 0 ? memory / total : 0;
  if (share < MEMORY_WARN_SHARE) {
    return null;
  }
  return {
    kind: 'memory-hog',
    level: share >= MEMORY_CRITICAL_SHARE ? 'critical' : 'warning',
    detail: `Holds ${formatBytes(memory)}, ${round(share * 100)}% of this machine's memory.`,
  };
}

function diskHog(window: Window): ProcessFlag | null {
  const disk = windowMean(window.history, (s) => s.diskPerSec);
  if (disk === null || disk < DISK_HOG_PER_SEC) {
    return null;
  }
  return {
    kind: 'disk-hog',
    level: 'warning',
    detail: `Moved ${formatBytes(disk)} a second to and from disk for the last ${round(window.seconds)}s.`,
  };
}

function networkHog(window: Window): ProcessFlag | null {
  const network = windowMean(window.history, (s) => s.networkPerSec);
  if (network === null || network < NETWORK_HOG_PER_SEC) {
    return null;
  }
  return {
    kind: 'network-hog',
    level: 'warning',
    detail: `Moved ${formatBytes(network)} a second over the network for the last ${round(window.seconds)}s.`,
  };
}

/** Ready to run the whole window, yet getting little CPU while the machine has more work than cores. */
function starved(window: Window): ProcessFlag | null {
  const { cpu, machine } = window;
  const loadPerCore = machine.cores > 0 ? machine.load1 / machine.cores : 0;
  const runnable = trailing(window.history, (s) => s.state.startsWith('R')) >= HISTORY;
  if (!runnable || cpu === null || cpu >= STARVED_CPU_PCT || loadPerCore < STARVED_LOAD_PER_CORE) {
    return null;
  }
  return {
    kind: 'starved',
    level: 'warning',
    detail: `Ready to run for the last ${round(window.seconds)}s but got only ${round(cpu)}% CPU, because load is ${machine.load1.toFixed(1)} on ${String(machine.cores)} cores.`,
  };
}

const USAGE_CHECKS = [cpuHog, memoryHog, diskHog, networkHog, starved];

function usageFlags(
  history: readonly ProcessSnapshot[],
  machine: MachineContext,
  seconds: number,
): ProcessFlag[] {
  const window: Window = { history, machine, seconds, cpu: windowMean(history, (s) => s.cpuPct) };
  return USAGE_CHECKS.map((check) => check(window)).filter((flag) => flag !== null);
}

/** Flags for one process from its samples, oldest first. */
export function processFlags(
  history: readonly ProcessSnapshot[],
  machine: MachineContext,
  intervalMs: number,
  wchan: string | null,
): ProcessFlag[] {
  const seconds = (samples: number): number => (samples * intervalMs) / 1000;
  return [
    ...stateFlags(history, seconds, wchan),
    ...usageFlags(history, machine, seconds(HISTORY)),
  ];
}

function graded(value: number, warning: number, critical: number): ActivityLevel | null {
  if (value >= critical) {
    return 'critical';
  }
  return value >= warning ? 'warning' : null;
}

function machineAlert(level: ActivityLevel, message: string): ActivityAlert {
  return { level, sessionId: null, pid: null, subject: 'Machine', message };
}

function stallAlerts(machine: MachineActivity): ActivityAlert[] {
  const { stall } = machine;
  if (stall === null) {
    return [];
  }
  const checks = [
    { value: stall.cpu, warning: 50, critical: 80, what: 'for CPU' },
    { value: stall.memory, warning: 10, critical: 30, what: 'on memory' },
    { value: stall.io, warning: 20, critical: 50, what: 'on disk I/O' },
  ] as const;
  const out: ActivityAlert[] = [];
  for (const { value, warning, critical, what } of checks) {
    const level = value === null ? null : graded(value, warning, critical);
    if (value !== null && level !== null) {
      out.push(
        machineAlert(level, `Tasks waited ${what} ${round(value)}% of the last 10 seconds.`),
      );
    }
  }
  return out;
}

const LOW_FREE_BYTES = 2 * GIGABYTE;

function diskLevel(freeBytes: number, totalBytes: number): ActivityLevel | null {
  const share = freeBytes / totalBytes;
  if (share < 0.05 || freeBytes < LOW_FREE_BYTES) {
    return 'critical';
  }
  return share < 0.1 ? 'warning' : null;
}

function volumeAlerts(machine: MachineActivity): ActivityAlert[] {
  const out: ActivityAlert[] = [];
  for (const volume of machine.volumes) {
    if (!volume.responding) {
      out.push(
        machineAlert(
          'critical',
          `The filesystem holding ${volume.path} did not answer, so anything reading it will hang.`,
        ),
      );
      continue;
    }
    if (volume.freeBytes === null || volume.totalBytes === null || volume.totalBytes <= 0) {
      continue;
    }
    const level = diskLevel(volume.freeBytes, volume.totalBytes);
    if (level !== null) {
      out.push(
        machineAlert(
          level,
          `Only ${formatBytes(volume.freeBytes)} free on the disk holding ${volume.path}.`,
        ),
      );
    }
  }
  return out;
}

function pressureAlerts(machine: MachineActivity): ActivityAlert[] {
  const out: ActivityAlert[] = [];
  const loadLevel = graded(machine.loadAverage[0] / Math.max(1, machine.cores), 1.2, 2);
  if (loadLevel !== null) {
    out.push(
      machineAlert(
        loadLevel,
        `Load is ${machine.loadAverage[0].toFixed(1)} on ${String(machine.cores)} cores, so ready processes queue for CPU.`,
      ),
    );
  }
  if (machine.memoryPressure === 'warning' || machine.memoryPressure === 'critical') {
    out.push(
      machineAlert(
        machine.memoryPressure,
        `macOS reports memory pressure as ${machine.memoryPressure}, so it is compressing memory and swapping.`,
      ),
    );
  }
  const { swapUsedBytes, swapTotalBytes } = machine;
  if (swapUsedBytes !== null && swapTotalBytes !== null && swapTotalBytes > 0) {
    const share = swapUsedBytes / swapTotalBytes;
    if (share >= 0.8) {
      out.push(machineAlert('warning', `Swap is ${round(share * 100)}% full.`));
    }
  }
  const limit = machine.cpuSpeedLimitPct;
  if (limit !== null && limit < 100) {
    out.push(
      machineAlert(
        limit <= 50 ? 'critical' : 'warning',
        `macOS has slowed the CPU to ${String(limit)}% of its speed for heat or power.`,
      ),
    );
  }
  return out;
}

/** Trouble with the machine as a whole. */
export function machineAlerts(machine: MachineActivity): ActivityAlert[] {
  return [...pressureAlerts(machine), ...stallAlerts(machine), ...volumeAlerts(machine)];
}

/** Critical first, and otherwise in the order given. */
export function sortAlerts(alerts: readonly ActivityAlert[]): ActivityAlert[] {
  return alerts.toSorted(
    (left, right) => Number(right.level === 'critical') - Number(left.level === 'critical'),
  );
}
