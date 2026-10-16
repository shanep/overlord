// One reading of the machine: the process table, the session processes'
// command lines and disk counters, network counters, memory and volumes.
// Reads that this platform cannot do come back null and leave a note.

import { statfs as nodeStatfs } from 'node:fs/promises';

import type { PressureStall, VolumeActivity } from '../../shared/activity.js';
import type { FileSystem } from '../context/fs.js';
import type { Exec } from '../sync/exec.js';
import { NOT_FOUND_CODE } from '../sync/exec.js';

import type { Counter, OwnedCounter } from './io.js';
import {
  DARWIN_DISK_SCRIPT,
  NETTOP_ARGS,
  ownedByPid,
  parseNettop,
  parseProcIo,
  parseSs,
  parseTriples,
  SS_ARGS,
} from './io.js';
import type { CoreTimes, CpuTimes, Memory } from './machine.js';
import {
  parseMeminfo,
  parsePressureLevel,
  parseSpeedLimit,
  parseSwapUsage,
  parseVmStat,
  stallFrom,
  sumCpuTimes,
} from './machine.js';
import type { LinuxUnits, ProcessRow } from './process-table.js';
import {
  DARWIN_PS_ARGS,
  DEFAULT_LINUX_UNITS,
  parseArgs,
  parseCmdline,
  parseDarwinPs,
  readLinuxProcesses,
} from './process-table.js';

export interface RawSample {
  readonly at: number;
  readonly rows: readonly ProcessRow[];
  readonly args: ReadonlyMap<number, string>;
  /** Null when this platform cannot count disk bytes per process. */
  readonly disk: ReadonlyMap<string, OwnedCounter> | null;
  readonly network: ReadonlyMap<string, OwnedCounter> | null;
  /** Where the kernel has a blocked Linux process waiting. */
  readonly wchan: ReadonlyMap<number, string>;
  readonly cpu: CpuTimes;
  readonly cores: number;
  readonly loadAverage: readonly [number, number, number];
  readonly memoryTotalBytes: number;
  readonly memory: Memory;
  readonly memoryPressure: 'normal' | 'warning' | 'critical' | null;
  readonly stall: PressureStall | null;
  readonly cpuSpeedLimitPct: number | null;
  readonly volumes: readonly VolumeActivity[];
}

export interface Space {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** What os gives about the machine, so tests can pass fixed numbers. */
export interface MachineProbe {
  readonly cpus: () => readonly CoreTimes[];
  readonly loadavg: () => readonly number[];
  readonly totalmem: () => number;
}

export interface SampleDeps {
  readonly platform: NodeJS.Platform;
  readonly exec: Exec;
  readonly fs: FileSystem;
  readonly clock: () => number;
  readonly machine: MachineProbe;
  /** Free and total bytes on the volume holding a path. May never settle on a hung mount. */
  readonly statfs: (target: string) => Promise<Space>;
  /** Waits ms milliseconds, for the statfs time limit. */
  readonly delay: (ms: number) => Promise<void>;
}

export async function defaultStatfs(target: string): Promise<Space> {
  const info = await nodeStatfs(target);
  return { freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
}

const COMMAND_TIMEOUT_MS = 5000;
export const STATFS_TIMEOUT_MS = 2000;
const NO_UNITS = Symbol('no units');

export const NOTES = {
  unsupported: 'Activity is only measured on macOS and Linux.',
  python:
    'Disk use per process needs python3 from the Xcode command line tools (xcode-select --install).',
  nettop: 'Network use per process needs nettop, which did not run.',
  ss: 'Network use per process needs ss from iproute2.',
  tcpOnly: 'Network use counts TCP traffic only.',
} as const;

function loadTriple(values: readonly number[]): readonly [number, number, number] {
  const [one = 0, five = 0, fifteen = 0] = values;
  return [one, five, fifteen];
}

export class Sampler {
  private units: LinuxUnits | typeof NO_UNITS = NO_UNITS;
  private python: Promise<boolean> | null = null;
  /** Folders whose statfs has not settled, so a hung mount gets one call, not one per sample. */
  private readonly hung = new Set<string>();
  private readonly noteSet = new Set<string>();

  constructor(private readonly deps: SampleDeps) {}

  get notes(): readonly string[] {
    return [...this.noteSet];
  }

  private get supported(): boolean {
    return this.deps.platform === 'darwin' || this.deps.platform === 'linux';
  }

  /** Reads everything. Session roots decide whose command lines and disk counters to read. */
  async read(
    treeOf: (rows: readonly ProcessRow[]) => readonly number[],
    folders: readonly string[],
  ): Promise<RawSample> {
    if (!this.supported) {
      this.noteSet.add(NOTES.unsupported);
    }
    const [rows, network, machine, volumes] = await Promise.all([
      this.rows(),
      this.network(),
      this.machine(),
      this.volumes(folders),
    ]);
    const pids = treeOf(rows);
    const [args, disk, wchan] = await Promise.all([
      this.args(pids),
      this.disk(pids),
      this.wchan(rows, pids),
    ]);
    return { at: this.deps.clock(), rows, args, disk, network, wchan, volumes, ...machine };
  }

  private async run(command: string, args: readonly string[]): Promise<string | null> {
    const result = await this.deps.exec(command, args, { timeoutMs: COMMAND_TIMEOUT_MS });
    return result.code === 0 ? result.stdout : null;
  }

  private async linuxUnits(): Promise<LinuxUnits> {
    if (this.units === NO_UNITS) {
      const [ticks, page] = await Promise.all([
        this.run('getconf', ['CLK_TCK']),
        this.run('getconf', ['PAGESIZE']),
      ]);
      const positive = (text: string | null, fallback: number): number => {
        const value = Number(text?.trim());
        return Number.isFinite(value) && value > 0 ? value : fallback;
      };
      this.units = {
        ticksPerSecond: positive(ticks, DEFAULT_LINUX_UNITS.ticksPerSecond),
        pageBytes: positive(page, DEFAULT_LINUX_UNITS.pageBytes),
      };
    }
    return this.units;
  }

  private async rows(): Promise<readonly ProcessRow[]> {
    if (this.deps.platform === 'darwin') {
      return parseDarwinPs((await this.run('ps', DARWIN_PS_ARGS)) ?? '');
    }
    if (this.deps.platform === 'linux') {
      return readLinuxProcesses(this.deps.fs, await this.linuxUnits());
    }
    return [];
  }

  private async args(pids: readonly number[]): Promise<ReadonlyMap<number, string>> {
    if (pids.length === 0) {
      return new Map();
    }
    if (this.deps.platform === 'darwin') {
      return parseArgs((await this.run('ps', ['-o', 'pid=,args=', '-p', pids.join(',')])) ?? '');
    }
    const lines = await Promise.all(
      pids.map(async (pid) => {
        const text = await this.deps.fs.readFile(`/proc/${String(pid)}/cmdline`);
        return [pid, text === null ? '' : parseCmdline(text)] as const;
      }),
    );
    return new Map(lines.filter(([, line]) => line !== ''));
  }

  /** xcode-select -p fails when the command line tools are missing, and /usr/bin/python3 would then pop an install dialog. */
  private async hasPython(): Promise<boolean> {
    this.python ??= this.run('xcode-select', ['-p']).then((out) => out !== null);
    return this.python;
  }

  private async disk(pids: readonly number[]): Promise<ReadonlyMap<string, OwnedCounter> | null> {
    if (this.deps.platform === 'darwin') {
      if (!(await this.hasPython())) {
        this.noteSet.add(NOTES.python);
        return null;
      }
      if (pids.length === 0) {
        return new Map();
      }
      const out = await this.run('/usr/bin/python3', [
        '-I',
        '-c',
        DARWIN_DISK_SCRIPT,
        ...pids.map(String),
      ]);
      return out === null ? null : ownedByPid(parseTriples(out));
    }
    if (this.deps.platform !== 'linux') {
      return null;
    }
    const counters = await Promise.all(
      pids.map(async (pid) => {
        const text = await this.deps.fs.readFile(`/proc/${String(pid)}/io`);
        return [pid, text === null ? null : parseProcIo(text)] as const;
      }),
    );
    const known = counters.filter(
      (entry): entry is readonly [number, Counter] => entry[1] !== null,
    );
    return ownedByPid(new Map(known));
  }

  private async network(): Promise<ReadonlyMap<string, OwnedCounter> | null> {
    if (this.deps.platform === 'darwin') {
      const out = await this.run('nettop', NETTOP_ARGS);
      if (out === null) {
        this.noteSet.add(NOTES.nettop);
      }
      return out === null ? null : parseNettop(out);
    }
    if (this.deps.platform !== 'linux') {
      return null;
    }
    this.noteSet.add(NOTES.tcpOnly);
    const result = await this.deps.exec('ss', SS_ARGS, { timeoutMs: COMMAND_TIMEOUT_MS });
    if (result.code === NOT_FOUND_CODE) {
      this.noteSet.add(NOTES.ss);
    }
    return result.code === 0 ? parseSs(result.stdout) : null;
  }

  private async wchan(
    rows: readonly ProcessRow[],
    pids: readonly number[],
  ): Promise<ReadonlyMap<number, string>> {
    if (this.deps.platform !== 'linux') {
      return new Map();
    }
    const mine = new Set(pids);
    const blocked = rows.filter((row) => row.state.startsWith('D') && mine.has(row.pid));
    const entries = await Promise.all(
      blocked.map(async (row) => {
        const raw = await this.deps.fs.readFile(`/proc/${String(row.pid)}/wchan`);
        const text = raw?.trim() ?? '';
        return [row.pid, text] as const;
      }),
    );
    return new Map(entries.filter(([, text]) => text !== '' && text !== '0'));
  }

  private async machine(): Promise<
    Pick<
      RawSample,
      | 'cpu'
      | 'cores'
      | 'loadAverage'
      | 'memoryTotalBytes'
      | 'memory'
      | 'memoryPressure'
      | 'stall'
      | 'cpuSpeedLimitPct'
    >
  > {
    const { machine } = this.deps;
    const cores = machine.cpus();
    const memoryTotalBytes = machine.totalmem();
    const base = {
      cpu: sumCpuTimes(cores),
      cores: cores.length,
      loadAverage: loadTriple(machine.loadavg()),
      memoryTotalBytes,
    };
    if (this.deps.platform === 'darwin') {
      const [vm, swap, pressure, therm] = await Promise.all([
        this.run('vm_stat', []),
        this.run('sysctl', ['-n', 'vm.swapusage']),
        this.run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
        this.run('pmset', ['-g', 'therm']),
      ]);
      return {
        ...base,
        memory: {
          usedBytes: vm === null ? null : parseVmStat(vm, memoryTotalBytes),
          ...parseSwapUsage(swap ?? ''),
        },
        memoryPressure: parsePressureLevel(pressure ?? ''),
        stall: null,
        cpuSpeedLimitPct: therm === null ? null : parseSpeedLimit(therm),
      };
    }
    const read = async (file: string): Promise<string | null> =>
      this.deps.platform === 'linux' ? this.deps.fs.readFile(file) : null;
    const [meminfo, cpu, memory, io] = await Promise.all([
      read('/proc/meminfo'),
      read('/proc/pressure/cpu'),
      read('/proc/pressure/memory'),
      read('/proc/pressure/io'),
    ]);
    return {
      ...base,
      memory:
        meminfo === null
          ? { usedBytes: null, swapUsedBytes: null, swapTotalBytes: null }
          : parseMeminfo(meminfo),
      memoryPressure: null,
      stall: stallFrom(cpu, memory, io),
      cpuSpeedLimitPct: null,
    };
  }

  private async volume(folder: string): Promise<VolumeActivity> {
    if (this.hung.has(folder)) {
      return { path: folder, freeBytes: null, totalBytes: null, responding: false };
    }
    this.hung.add(folder);
    const settled = this.deps.statfs(folder).then(
      (space) => {
        this.hung.delete(folder);
        return space;
      },
      () => {
        this.hung.delete(folder);
        return null;
      },
    );
    const timedOut = this.deps.delay(STATFS_TIMEOUT_MS).then(() => 'timeout' as const);
    const space = await Promise.race([settled, timedOut]);
    if (space === 'timeout') {
      return { path: folder, freeBytes: null, totalBytes: null, responding: false };
    }
    return {
      path: folder,
      freeBytes: space?.freeBytes ?? null,
      totalBytes: space?.totalBytes ?? null,
      responding: true,
    };
  }

  /** One entry per volume. Folders on the same volume report the same space, so the first stands for the rest. */
  private async volumes(folders: readonly string[]): Promise<readonly VolumeActivity[]> {
    const all = await Promise.all([...new Set(folders)].map(async (folder) => this.volume(folder)));
    const seen = new Set<string>();
    return all.filter((volume) => {
      if (!volume.responding) {
        return true;
      }
      if (volume.totalBytes === null) {
        return false;
      }
      const key = `${String(volume.totalBytes)}:${String(volume.freeBytes)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}
