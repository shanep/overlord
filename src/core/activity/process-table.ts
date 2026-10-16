// Every process on the machine with its parent, state, memory and the CPU
// time it has used so far. macOS reads `ps`. Linux reads /proc directly,
// since its `ps` only reports CPU time to the whole second.

import type { FileSystem } from '../context/fs.js';

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly state: string;
  readonly rssBytes: number;
  /** CPU time used since the process started, user plus system. */
  readonly cpuMs: number;
  readonly name: string;
}

/** The `ps` columns parseDarwinPs reads, with the free text name last. */
export const DARWIN_PS_ARGS = ['-A', '-o', 'pid=,ppid=,stat=,rss=,time=,comm='];

const KIB = 1024;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_DAY = 86_400;

/** CPU time as `ps` prints it: [[dd-]hh:]mm:ss[.cc]. NaN when it is something else. */
export function parseCpuTime(text: string): number {
  const dash = text.indexOf('-');
  const days = dash === -1 ? 0 : Number(text.slice(0, dash));
  const parts = text.slice(dash + 1).split(':');
  if (parts.length < 2 || parts.length > 3 || parts.includes('')) {
    return Number.NaN;
  }
  const seconds = parts.reduce((total, part) => total * SECONDS_PER_MINUTE + Number(part), 0);
  return (days * SECONDS_PER_DAY + seconds) * MS_PER_SECOND;
}

function baseName(command: string): string {
  return command.slice(command.lastIndexOf('/') + 1);
}

const DARWIN_PREFIX = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s/u;

/** Rows from `ps -o pid=,ppid=,stat=,rss=,time=,comm=`. Lines that do not fit are skipped. */
export function parseDarwinPs(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = DARWIN_PREFIX.exec(line);
    if (match === null) {
      continue;
    }
    const [prefix, pid = '', ppid = '', state = '', rss = '', time = ''] = match;
    const command = line.slice(prefix.length);
    const cpuMs = parseCpuTime(time);
    if (Number.isNaN(cpuMs)) {
      continue;
    }
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      state,
      rssBytes: Number(rss) * KIB,
      cpuMs,
      name: baseName(command.trim()),
    });
  }
  return rows;
}

/** Clock ticks per second and bytes per page, from getconf. */
export interface LinuxUnits {
  readonly ticksPerSecond: number;
  readonly pageBytes: number;
}

export const DEFAULT_LINUX_UNITS: LinuxUnits = { ticksPerSecond: 100, pageBytes: 4096 };

// Fields after the parenthesized name in /proc/<pid>/stat, counted from 0.
const STAT_STATE = 0;
const STAT_PPID = 1;
const STAT_UTIME = 11;
const STAT_STIME = 12;
const STAT_RSS = 21;

/** One /proc/<pid>/stat line. The name sits in parentheses and may itself hold spaces or parentheses. */
export function parseProcStat(pid: number, text: string, units: LinuxUnits): ProcessRow | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open === -1 || close < open) {
    return null;
  }
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  if (fields.length <= STAT_RSS) {
    return null;
  }
  const field = (index: number): number => Number(fields[index]);
  const ticks = field(STAT_UTIME) + field(STAT_STIME);
  return {
    pid,
    ppid: field(STAT_PPID),
    state: String(fields[STAT_STATE]),
    rssBytes: field(STAT_RSS) * units.pageBytes,
    cpuMs: (ticks / units.ticksPerSecond) * MS_PER_SECOND,
    name: text.slice(open + 1, close),
  };
}

const NUMERIC = /^\d+$/u;

/** Every process under /proc. One that exits while it is read is left out. */
export async function readLinuxProcesses(fs: FileSystem, units: LinuxUnits): Promise<ProcessRow[]> {
  const names = await fs.readdir('/proc');
  const pids = names.filter((name) => NUMERIC.test(name)).map(Number);
  const rows = await Promise.all(
    pids.map(async (pid) => {
      const text = await fs.readFile(`/proc/${String(pid)}/stat`);
      return text === null ? null : parseProcStat(pid, text, units);
    }),
  );
  return rows.filter((row) => row !== null);
}

/** The NUL separated /proc/<pid>/cmdline as one line. */
export function parseCmdline(text: string): string {
  return text.split('\0').filter(Boolean).join(' ');
}

/** `ps -o pid=,args=` output, pid to command line. */
export function parseArgs(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s/u.exec(line);
    if (match !== null) {
      out.set(Number(match[1]), line.slice(match[0].length).trim());
    }
  }
  return out;
}

/**
 * The root and every process under it, root first, then breadth first. The
 * subtrees under `stop` are left out, so a session started from inside
 * another session's shell is not counted twice.
 */
export function descendants(
  root: ProcessRow,
  rows: readonly ProcessRow[],
  stop: ReadonlySet<number> = new Set(),
): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) {
      continue;
    }
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const out = [root];
  const seen = new Set([root.pid]);
  // The loop also visits the rows it appends, which makes it breadth first.
  for (const parent of out) {
    for (const child of children.get(parent.pid) ?? []) {
      if (!seen.has(child.pid) && !stop.has(child.pid)) {
        seen.add(child.pid);
        out.push(child);
      }
    }
  }
  return out;
}
