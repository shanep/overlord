// Turns two readings into the activity view: rates from the difference,
// each session's process tree with its totals, and the flags and alerts.

import type {
  ActivityAlert,
  ActivityProcess,
  ActivitySession,
  ActivityState,
  MachineActivity,
  Rates,
} from '../../shared/activity.js';
import type { SessionPlace } from '../../shared/model.js';

import type { MachineContext, ProcessSnapshot } from './flags.js';
import { HISTORY, machineAlerts, processFlags, sortAlerts } from './flags.js';
import type { Counter, OwnedCounter } from './io.js';
import { rateByPid } from './io.js';
import { machineCpuPct } from './machine.js';
import type { ProcessRow } from './process-table.js';
import { descendants } from './process-table.js';
import type { RawSample } from './sample.js';

/** A live session and the process Claude Code runs it in. */
export interface SessionRef {
  readonly sessionId: string;
  readonly pid: number;
  readonly title: string;
  readonly cwd: string;
  readonly place: SessionPlace | null;
}

export interface BuildInput {
  readonly previous: RawSample | null;
  readonly current: RawSample;
  readonly sessions: readonly SessionRef[];
  readonly histories: ReadonlyMap<number, readonly ProcessSnapshot[]>;
  readonly intervalMs: number;
  readonly notes: readonly string[];
}

export interface BuildResult {
  readonly state: ActivityState;
  /** Samples per pid for the next build, only for processes still running. */
  readonly histories: Map<number, ProcessSnapshot[]>;
}

const COMMAND_MAX = 300;
const NO_RATES: Rates = { readPerSec: null, writePerSec: null };

export function emptyActivity(intervalMs: number): ActivityState {
  return {
    sampledAt: null,
    intervalMs,
    machine: {
      cores: 0,
      cpuPct: null,
      loadAverage: [0, 0, 0],
      memoryTotalBytes: 0,
      memoryUsedBytes: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
      memoryPressure: null,
      stall: null,
      cpuSpeedLimitPct: null,
      volumes: [],
    },
    sessions: [],
    alerts: [],
    notes: [],
  };
}

export interface SessionTree {
  readonly session: SessionRef;
  /** The session's process first, then everything under it. */
  readonly rows: readonly ProcessRow[];
}

/** Every session whose process is running, each leaving out the other sessions' subtrees. */
export function sessionTrees(
  sessions: readonly SessionRef[],
  rows: readonly ProcessRow[],
): SessionTree[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const roots = new Set(sessions.map((session) => session.pid));
  return sessions.flatMap((session) => {
    const root = byPid.get(session.pid);
    if (root === undefined) {
      return [];
    }
    const others = new Set([...roots].filter((pid) => pid !== session.pid));
    return [{ session, rows: descendants(root, rows, others) }];
  });
}

function machineOf(current: RawSample, previous: RawSample | null): MachineActivity {
  return {
    cores: current.cores,
    cpuPct: previous === null ? null : machineCpuPct(previous.cpu, current.cpu),
    loadAverage: current.loadAverage,
    memoryTotalBytes: current.memoryTotalBytes,
    memoryUsedBytes: current.memory.usedBytes,
    swapUsedBytes: current.memory.swapUsedBytes,
    swapTotalBytes: current.memory.swapTotalBytes,
    memoryPressure: current.memoryPressure,
    stall: current.stall,
    cpuSpeedLimitPct: current.cpuSpeedLimitPct,
    volumes: current.volumes,
  };
}

function rateTable(
  before: ReadonlyMap<string, OwnedCounter> | null | undefined,
  after: ReadonlyMap<string, OwnedCounter> | null,
  seconds: number,
): Map<number, Counter> | null {
  if (before === null || before === undefined || after === null || seconds <= 0) {
    return null;
  }
  return rateByPid(before, after, seconds);
}

function ratesFor(pid: number, table: ReadonlyMap<number, Counter> | null): Rates {
  if (table === null) {
    return NO_RATES;
  }
  const counter = table.get(pid);
  return { readPerSec: counter?.read ?? 0, writePerSec: counter?.write ?? 0 };
}

function total(rates: Rates): number | null {
  return rates.readPerSec === null || rates.writePerSec === null
    ? null
    : rates.readPerSec + rates.writePerSec;
}

function sumRates(list: readonly Rates[]): Rates {
  let readPerSec = 0;
  let writePerSec = 0;
  for (const entry of list) {
    if (entry.readPerSec === null || entry.writePerSec === null) {
      return NO_RATES;
    }
    readPerSec += entry.readPerSec;
    writePerSec += entry.writePerSec;
  }
  return { readPerSec, writePerSec };
}

function sumCpu(processes: readonly ActivityProcess[]): number | null {
  let sum: number | null = null;
  for (const entry of processes) {
    if (entry.cpuPct !== null) {
      sum = (sum ?? 0) + entry.cpuPct;
    }
  }
  return sum;
}

function cpuKey(process: ActivityProcess): number {
  return process.cpuPct ?? -1;
}

function busiestFirst(left: ActivityProcess, right: ActivityProcess): number {
  return cpuKey(right) - cpuKey(left) || right.memoryBytes - left.memoryBytes;
}

interface Context {
  readonly input: BuildInput;
  readonly elapsedMs: number;
  readonly before: ReadonlyMap<number, ProcessRow>;
  readonly disk: ReadonlyMap<number, Counter> | null;
  readonly network: ReadonlyMap<number, Counter> | null;
  readonly machine: MachineContext;
  readonly histories: Map<number, ProcessSnapshot[]>;
}

function cpuOf(row: ProcessRow, context: Context): number | null {
  const then = context.before.get(row.pid);
  if (then?.name !== row.name || context.elapsedMs <= 0) {
    return null;
  }
  return Math.max(0, ((row.cpuMs - then.cpuMs) / context.elapsedMs) * 100);
}

function processOf(row: ProcessRow, context: Context): ActivityProcess {
  const { current, intervalMs } = context.input;
  const disk = ratesFor(row.pid, context.disk);
  const network = ratesFor(row.pid, context.network);
  const cpuPct = cpuOf(row, context);
  const snapshot: ProcessSnapshot = {
    state: row.state,
    cpuPct,
    memoryBytes: row.rssBytes,
    diskPerSec: total(disk),
    networkPerSec: total(network),
  };
  const history = [...(context.input.histories.get(row.pid) ?? []), snapshot].slice(-HISTORY);
  context.histories.set(row.pid, history);
  const command = current.args.get(row.pid) ?? row.name;
  return {
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    command: command.length > COMMAND_MAX ? `${command.slice(0, COMMAND_MAX)}...` : command,
    state: row.state,
    cpuPct,
    memoryBytes: row.rssBytes,
    disk,
    network,
    flags: processFlags(history, context.machine, intervalMs, current.wchan.get(row.pid) ?? null),
  };
}

function sessionOf(tree: SessionTree, context: Context): ActivitySession {
  const { session } = tree;
  const processes = tree.rows.map((row) => processOf(row, context));
  return {
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    pid: session.pid,
    place: session.place,
    cpuPct: sumCpu(processes),
    memoryBytes: processes.reduce((sum, entry) => sum + entry.memoryBytes, 0),
    disk: sumRates(processes.map((entry) => entry.disk)),
    network: sumRates(processes.map((entry) => entry.network)),
    processes: [...processes.slice(0, 1), ...processes.slice(1).toSorted(busiestFirst)],
  };
}

function processAlerts(sessions: readonly ActivitySession[]): ActivityAlert[] {
  return sessions.flatMap((session) =>
    session.processes.flatMap((process) =>
      process.flags.map((flag) => ({
        level: flag.level,
        sessionId: session.sessionId,
        pid: process.pid,
        subject: `${process.name} (${String(process.pid)}) in ${session.title}`,
        message: flag.detail,
      })),
    ),
  );
}

export function buildActivity(input: BuildInput): BuildResult {
  const { current, previous } = input;
  const elapsedMs = previous === null ? 0 : current.at - previous.at;
  const seconds = elapsedMs / 1000;
  const machine = machineOf(current, previous);
  const context: Context = {
    input,
    elapsedMs,
    before: new Map(previous?.rows.map((row) => [row.pid, row])),
    disk: rateTable(previous?.disk, current.disk, seconds),
    network: rateTable(previous?.network, current.network, seconds),
    machine: {
      cores: machine.cores,
      cpuPct: machine.cpuPct,
      load1: machine.loadAverage[0],
      memoryTotalBytes: machine.memoryTotalBytes,
    },
    histories: new Map(),
  };
  const sessions = sessionTrees(input.sessions, current.rows)
    .map((tree) => sessionOf(tree, context))
    .toSorted((left, right) => left.title.localeCompare(right.title));
  return {
    state: {
      sampledAt: current.at,
      intervalMs: input.intervalMs,
      machine,
      sessions,
      alerts: sortAlerts([...machineAlerts(machine), ...processAlerts(sessions)]),
      notes: input.notes,
    },
    histories: context.histories,
  };
}
