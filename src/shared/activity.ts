// What the activity view shows: how hard each running session works this
// machine (CPU, memory, disk and network for its whole process tree), the
// machine as a whole, and the processes that hog, starve or are stuck.

import type { AgentId } from './agents.js';
import type { SessionPlace } from './model.js';

export type ActivityLevel = 'warning' | 'critical';

/**
 * Why a process stands out. Hogs take more than their share, a starved process
 * is ready to run but gets little CPU, a blocked one sits in an uninterruptible
 * wait (nearly always disk or a network filesystem), a stopped one was paused
 * by a signal, and a zombie exited without its parent collecting it.
 */
export type ProcessFlagKind =
  | 'cpu-hog'
  | 'memory-hog'
  | 'disk-hog'
  | 'network-hog'
  | 'starved'
  | 'blocked'
  | 'stopped'
  | 'zombie';

export interface ProcessFlag {
  readonly kind: ProcessFlagKind;
  readonly level: ActivityLevel;
  readonly detail: string;
}

/** Bytes per second each way, null when this platform cannot measure it. */
export interface Rates {
  readonly readPerSec: number | null;
  readonly writePerSec: number | null;
}

export interface ActivityProcess {
  readonly pid: number;
  readonly ppid: number;
  /** The executable's short name. */
  readonly name: string;
  /** The command line, cut short. */
  readonly command: string;
  /** The OS state letter: R running, S sleeping, I idle, D or U uninterruptible, T stopped, Z zombie. */
  readonly state: string;
  /** Percent of one core, like Activity Monitor. Null on the first sample. */
  readonly cpuPct: number | null;
  readonly memoryBytes: number;
  /** Disk bytes read and written per second. */
  readonly disk: Rates;
  /** Network bytes received (read) and sent (write) per second. */
  readonly network: Rates;
  readonly flags: readonly ProcessFlag[];
}

export interface ActivitySession {
  readonly sessionId: string;
  /** The CLI that owns this session, when its live registry identifies one. */
  readonly agent?: AgentId;
  readonly title: string;
  readonly cwd: string;
  readonly pid: number;
  readonly place: SessionPlace | null;
  /** Sums over the whole process tree. */
  readonly cpuPct: number | null;
  readonly memoryBytes: number;
  readonly disk: Rates;
  readonly network: Rates;
  /** The session's process first, then its descendants, busiest first. */
  readonly processes: readonly ActivityProcess[];
}

/** Linux pressure stall information: percent of the last 10 seconds some task waited. */
export interface PressureStall {
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly io: number | null;
}

export interface VolumeActivity {
  /** A session folder on the volume. */
  readonly path: string;
  readonly freeBytes: number | null;
  readonly totalBytes: number | null;
  /** False when the filesystem did not answer in time, as a hung network mount does. */
  readonly responding: boolean;
}

export interface MachineActivity {
  readonly cores: number;
  /** Percent of every core together. Null on the first sample. */
  readonly cpuPct: number | null;
  /** 1, 5 and 15 minute load averages. */
  readonly loadAverage: readonly [number, number, number];
  readonly memoryTotalBytes: number;
  readonly memoryUsedBytes: number | null;
  readonly swapUsedBytes: number | null;
  readonly swapTotalBytes: number | null;
  /** The kernel's own memory pressure verdict on macOS, null elsewhere. */
  readonly memoryPressure: 'normal' | 'warning' | 'critical' | null;
  readonly stall: PressureStall | null;
  /** The CPU speed limit macOS set for heat or power, 100 when not throttled, null when unknown. */
  readonly cpuSpeedLimitPct: number | null;
  readonly volumes: readonly VolumeActivity[];
}

export interface ActivityAlert {
  readonly level: ActivityLevel;
  /** Null for alerts about the machine. */
  readonly sessionId: string | null;
  readonly pid: number | null;
  /** The process or "Machine". */
  readonly subject: string;
  readonly message: string;
}

export interface ActivityState {
  /** Null until the first sample lands. */
  readonly sampledAt: number | null;
  readonly intervalMs: number;
  readonly machine: MachineActivity;
  readonly sessions: readonly ActivitySession[];
  /** Critical first. */
  readonly alerts: readonly ActivityAlert[];
  /** What this platform cannot measure and why, for example disk use without python3. */
  readonly notes: readonly string[];
}
