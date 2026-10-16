// Machine wide numbers: memory in use, swap, how much the kernel thinks
// memory is under pressure, pressure stalls on Linux, and whether macOS has
// slowed the CPU for heat. Each parser takes command output or file text, so
// it is tested without the real machine.

import type { PressureStall } from '../../shared/activity.js';

export interface Memory {
  readonly usedBytes: number | null;
  readonly swapUsedBytes: number | null;
  readonly swapTotalBytes: number | null;
}

/** "Label:   123" lines as label to number. vm_stat ends its numbers with a dot, /proc/meminfo with kB. */
export function labeledNumbers(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
    if (colon > 0 && Number.isFinite(value)) {
      out.set(line.slice(0, colon).trim(), value);
    }
  }
  return out;
}

/**
 * Memory in use from `vm_stat`: everything except free, inactive and
 * speculative pages, which macOS hands out again without swapping. That is
 * close to Activity Monitor's Memory Used.
 */
export function parseVmStat(stdout: string, totalBytes: number): number | null {
  const pageSize = /page size of (\d+) bytes/u.exec(stdout)?.[1];
  if (pageSize === undefined) {
    return null;
  }
  const counts = labeledNumbers(stdout);
  const pages = (label: string): number => counts.get(`Pages ${label}`) ?? 0;
  const available = pages('free') + pages('inactive') + pages('speculative');
  return Math.max(0, totalBytes - available * Number(pageSize));
}

const MEGABYTE = 1024 * 1024;

/** `sysctl -n vm.swapusage`: "total = 2048.00M  used = 1024.50M  free = ...". */
export function parseSwapUsage(stdout: string): Pick<Memory, 'swapUsedBytes' | 'swapTotalBytes'> {
  const total = /total = ([\d.]+)M/u.exec(stdout)?.[1];
  const used = /used = ([\d.]+)M/u.exec(stdout)?.[1];
  return {
    swapTotalBytes: total === undefined ? null : Number(total) * MEGABYTE,
    swapUsedBytes: used === undefined ? null : Number(used) * MEGABYTE,
  };
}

const KIB = 1024;

/** /proc/meminfo. In use is total less MemAvailable, the kernel's own estimate of what it can hand out. */
export function parseMeminfo(text: string): Memory {
  const counts = labeledNumbers(text);
  const bytes = (label: string): number | null => {
    const kib = counts.get(label);
    return kib === undefined ? null : kib * KIB;
  };
  const total = bytes('MemTotal');
  const available = bytes('MemAvailable');
  const swapTotal = bytes('SwapTotal');
  const swapFree = bytes('SwapFree');
  return {
    usedBytes: total === null || available === null ? null : total - available,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapTotal === null || swapFree === null ? null : swapTotal - swapFree,
  };
}

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
export function parsePressureLevel(stdout: string): 'normal' | 'warning' | 'critical' | null {
  switch (stdout.trim()) {
    case '1': {
      return 'normal';
    }
    case '2': {
      return 'warning';
    }
    case '4': {
      return 'critical';
    }
    default: {
      return null;
    }
  }
}

/** The "some avg10=" figure from a /proc/pressure file, or null when it is missing. */
export function parseStall(text: string | null): number | null {
  const match = text === null ? undefined : /^some avg10=([\d.]+)/mu.exec(text)?.[1];
  return match === undefined ? null : Number(match);
}

/** Null when the kernel has no pressure files, which is anything before 4.20 or without PSI. */
export function stallFrom(
  cpu: string | null,
  memory: string | null,
  io: string | null,
): PressureStall | null {
  const stall = { cpu: parseStall(cpu), memory: parseStall(memory), io: parseStall(io) };
  return stall.cpu === null && stall.memory === null && stall.io === null ? null : stall;
}

/** `pmset -g therm`. It prints CPU_Speed_Limit only once macOS has limited the CPU, so no line means 100. */
export function parseSpeedLimit(stdout: string): number {
  const match = /CPU_Speed_Limit\s*=\s*(\d+)/u.exec(stdout);
  return match === null ? 100 : Number(match[1]);
}

/** Per core busy and total CPU time, as os.cpus() reports it. */
export interface CpuTimes {
  readonly busy: number;
  readonly total: number;
}

export interface CoreTimes {
  readonly times: {
    readonly user: number;
    readonly nice: number;
    readonly sys: number;
    readonly idle: number;
    readonly irq: number;
  };
}

export function sumCpuTimes(cores: readonly CoreTimes[]): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const { times } of cores) {
    const used = times.user + times.nice + times.sys + times.irq;
    busy += used;
    total += used + times.idle;
  }
  return { busy, total };
}

/** Percent of every core busy between two readings, null when no time passed. */
export function machineCpuPct(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total;
  if (total <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, ((after.busy - before.busy) / total) * 100));
}
