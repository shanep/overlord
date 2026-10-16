// Keeps each live session's place (VS Code terminal, other terminal or
// background) current for the fleet. The session registry is cheap to read,
// so it is polled. `ps` runs only when the interactive processes or the
// terminals change, and panels hear about it only when a place changes.

import type { SessionPlace } from '../../shared/model.js';
import type { ClaudePaths } from '../paths.js';
import type { RegistryEntry } from '../surfaces/live.js';
import { readSessionRegistry } from '../surfaces/live.js';
import type { Placement } from '../surfaces/places.js';
import { liveEntries, parseProcessTable, placeSessions } from '../surfaces/places.js';
import type { ExecFunction, IsAlive } from '../surfaces/process.js';

import { messageOf } from './errors.js';

export interface PlacesDeps {
  readonly paths: ClaudePaths;
  readonly exec: ExecFunction;
  readonly isAlive: IsAlive;
  /** Process ids of the shells behind this window's terminals. */
  readonly terminalPids: () => Promise<readonly number[]>;
  readonly onChange: () => void;
  readonly report: (source: string, message: string) => void;
}

export const PLACES_REFRESH_MS = 5000;
const PS_TIMEOUT_MS = 5000;
const SOURCE = 'session places';

function byNumber(left: number, right: number): number {
  return left - right;
}

export class SessionPlaces {
  private current: Readonly<Record<string, SessionPlace>> = {};
  private placements: ReadonlyMap<string, Placement> = new Map();
  private parents: ReadonlyMap<number, number> = new Map();
  private treeKey = '';
  private running: Promise<void> | null = null;

  constructor(private readonly deps: PlacesDeps) {}

  /** Session id to place, for sessions with a live process. */
  get value(): Readonly<Record<string, SessionPlace>> {
    return this.current;
  }

  /** The shell pid of the VS Code terminal the session runs in, or null. */
  terminalFor(sessionId: string): number | null {
    return this.placements.get(sessionId)?.terminal ?? null;
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
      this.placements = placeSessions(live, this.parents, roots);
      const next = Object.fromEntries(
        [...this.placements].map(([sessionId, placement]) => [sessionId, placement.place]),
      );
      if (JSON.stringify(next) !== JSON.stringify(this.current)) {
        this.current = next;
        this.deps.onChange();
      }
    } catch (error: unknown) {
      this.deps.report(SOURCE, messageOf(error));
    }
  }

  /** The process tree only matters for interactive sessions while a terminal is open. */
  private async readTree(
    live: readonly RegistryEntry[],
    roots: ReadonlySet<number>,
  ): Promise<void> {
    const interactive = live.filter((entry) => entry.kind === 'interactive');
    const key =
      interactive.length === 0 || roots.size === 0
        ? ''
        : JSON.stringify([
            interactive.map((entry) => entry.pid).toSorted(byNumber),
            [...roots].toSorted(byNumber),
          ]);
    if (key === this.treeKey) {
      return;
    }
    if (key === '') {
      this.parents = new Map();
    } else {
      const ps = await this.deps.exec('ps', ['-A', '-o', 'pid=,ppid='], {
        timeoutMs: PS_TIMEOUT_MS,
      });
      this.parents = parseProcessTable(ps.stdout);
    }
    this.treeKey = key;
  }
}
