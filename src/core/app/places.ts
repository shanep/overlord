// Keeps each live session's place (VS Code terminal, other terminal or
// background) and its busy, idle or waiting status current for the fleet. The session
// registry is cheap to read, so it is polled every second, which is what
// makes a row's state icon follow the session closely. `ps` runs only when the
// interactive processes or the terminals change, and panels hear about it
// only when a place, a pid or a status changes.

import type { SessionPlace } from '../../shared/model.js';
import type { ClaudePaths } from '../paths.js';
import type { RegistryEntry } from '../surfaces/live.js';
import { readSessionRegistry } from '../surfaces/live.js';
import type { AttachClient, Placement } from '../surfaces/places.js';
import {
  liveEntries,
  parseAttachClients,
  parseProcessTable,
  placeSessions,
} from '../surfaces/places.js';
import type { ExecFunction, IsAlive } from '../surfaces/process.js';

import { messageOf } from './errors.js';

export interface PlacesDeps {
  readonly paths: ClaudePaths;
  readonly exec: ExecFunction;
  readonly isAlive: IsAlive;
  /** Process ids of the shells behind this window's terminals. */
  readonly terminalPids: () => Promise<readonly number[]>;
  /** Holds the sessions a terminal shows in the fleet, in place of the ones held before. */
  readonly keep: (sessionIds: readonly string[]) => Promise<void>;
  readonly onChange: () => void;
  /** A session went busy, idle or waiting, so whatever else knows its state should look again. */
  readonly onStatus: () => void;
  readonly report: (source: string, message: string) => void;
}

/** The focused terminal: the session Overlord opened it for, if any, and its shell pid. */
export interface ActiveTerminal {
  readonly sessionId: string | null;
  readonly processId: number | null;
}

/**
 * What Claude Code's session registry says a live session is doing. It writes
 * waiting the moment a permission prompt, a question or a dialog opens.
 */
export type RegistryStatus = 'busy' | 'idle' | 'waiting';

export const PLACES_REFRESH_MS = 1000;
const PS_TIMEOUT_MS = 5000;
const SOURCE = 'session places';

const STATUSES: ReadonlySet<string> = new Set<RegistryStatus>(['busy', 'idle', 'waiting']);

function isStatus(value: string | null): value is RegistryStatus {
  return value !== null && STATUSES.has(value);
}

function statusesOf(live: readonly RegistryEntry[]): Record<string, RegistryStatus> {
  const out: Record<string, RegistryStatus> = {};
  for (const entry of live) {
    if (isStatus(entry.status)) {
      out[entry.sessionId] = entry.status;
    }
  }
  return out;
}

function byNumber(left: number, right: number): number {
  return left - right;
}

export class SessionPlaces {
  private current: Readonly<Record<string, SessionPlace>> = {};
  private pids: Readonly<Record<string, number>> = {};
  private status: Readonly<Record<string, RegistryStatus>> = {};
  private placements: ReadonlyMap<string, Placement> = new Map();
  private parents: ReadonlyMap<number, number> = new Map();
  private attaches: readonly AttachClient[] = [];
  private treeKey = '';
  private running: Promise<void> | null = null;
  private active: ActiveTerminal | null = null;
  private version = 0;

  constructor(private readonly deps: PlacesDeps) {}

  /** Session id to place, for sessions with a live process. */
  get value(): Readonly<Record<string, SessionPlace>> {
    return this.current;
  }

  /** Sessions open in a terminal, in this window or another, sorted. */
  private viewed(): string[] {
    return Object.keys(this.current)
      .filter((sessionId) => this.current[sessionId] !== 'background')
      .toSorted((left, right) => left.localeCompare(right));
  }

  /** Busy, idle or waiting, as Claude Code itself reports it, for each live session that says. */
  get statuses(): Readonly<Record<string, RegistryStatus>> {
    return this.status;
  }

  /** The process id of a session that is running now, or null. */
  pidOf(sessionId: string): number | null {
    return this.pids[sessionId] ?? null;
  }

  /** The shell pid of the VS Code terminal the session runs in, or null. */
  terminalFor(sessionId: string): number | null {
    return this.placements.get(sessionId)?.terminal ?? null;
  }

  /** Remember the focused terminal, so the fleet can point at its session. */
  setActiveTerminal(terminal: ActiveTerminal | null): void {
    if (JSON.stringify(terminal) !== JSON.stringify(this.active)) {
      this.active = terminal;
      this.bump();
    }
  }

  /** The window came to the front, so the fleet should point at its session again. */
  windowFocused(): void {
    this.bump();
  }

  /**
   * Goes up whenever the focused terminal changes or the window comes back
   * to the front, so the fleet highlights again even when the session is the same.
   */
  get activeVersion(): number {
    return this.version;
  }

  private bump(): void {
    this.version += 1;
    this.deps.onChange();
  }

  /** The session in the focused terminal, or null when it shows none Overlord knows. */
  activeSession(): string | null {
    const { active } = this;
    if (active === null) {
      return null;
    }
    if (active.sessionId !== null) {
      return active.sessionId;
    }
    for (const [sessionId, placement] of this.placements) {
      if (placement.terminal !== null && placement.terminal === active.processId) {
        return sessionId;
      }
    }
    return null;
  }

  /** Read the registry again. Calls made while one runs share it. */
  async refresh(): Promise<void> {
    this.running ??= this.load().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async load(): Promise<void> {
    try {
      const [registry, terminals] = await Promise.all([
        readSessionRegistry(this.deps.paths),
        this.deps.terminalPids(),
      ]);
      const live = liveEntries(registry.items, this.deps.isAlive);
      const roots = new Set(terminals);
      await this.readTree(live, roots);
      this.placements = placeSessions(live, this.parents, roots, this.attaches);
      const next = Object.fromEntries(
        [...this.placements].map(([sessionId, placement]) => [sessionId, placement.place]),
      );
      const pids = Object.fromEntries(live.map((entry) => [entry.sessionId, entry.pid]));
      const status = statusesOf(live);
      if (JSON.stringify(status) !== JSON.stringify(this.status)) {
        this.status = status;
        this.deps.onChange();
        this.deps.onStatus();
      }
      if (
        JSON.stringify(next) !== JSON.stringify(this.current) ||
        JSON.stringify(pids) !== JSON.stringify(this.pids)
      ) {
        this.current = next;
        this.pids = pids;
        await this.deps.keep(this.viewed());
        this.deps.onChange();
      }
    } catch (error: unknown) {
      this.deps.report(SOURCE, messageOf(error));
    }
  }

  /**
   * The process tree only matters while a terminal is open: it ties an
   * interactive session to its terminal, and a background session to the tab
   * running `claude attach` for it.
   */
  private async readTree(
    live: readonly RegistryEntry[],
    roots: ReadonlySet<number>,
  ): Promise<void> {
    const placed = live.filter(
      (entry) => entry.kind === 'interactive' || entry.kind === 'background',
    );
    const key =
      placed.length === 0 || roots.size === 0
        ? ''
        : JSON.stringify([
            placed.map((entry) => entry.pid).toSorted(byNumber),
            [...roots].toSorted(byNumber),
          ]);
    if (key === this.treeKey) {
      return;
    }
    if (key === '') {
      this.parents = new Map();
      this.attaches = [];
    } else {
      const ps = await this.deps.exec('ps', ['-A', '-o', 'pid=,ppid=,args='], {
        timeoutMs: PS_TIMEOUT_MS,
      });
      this.parents = parseProcessTable(ps.stdout);
      this.attaches = parseAttachClients(ps.stdout);
    }
    this.treeKey = key;
  }
}
