// Keeps each live session's place (VS Code terminal, other terminal or
// background) current for the fleet. The session registry is cheap to read,
// so it is polled. `ps` runs only when the interactive processes or the
// terminals change, and panels hear about it only when a place changes.

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
  readonly onChange: () => void;
  readonly report: (source: string, message: string) => void;
}

/** The focused terminal: the session Overlord opened it for, if any, and its shell pid. */
export interface ActiveTerminal {
  readonly sessionId: string | null;
  readonly processId: number | null;
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
      if (JSON.stringify(next) !== JSON.stringify(this.current)) {
        this.current = next;
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
