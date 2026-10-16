// Where each live session runs. The session registry says whether a process
// is interactive or background, and the process tree says whether an
// interactive one hangs off a terminal in this VS Code window.

import type { SessionPlace } from '../../shared/model.js';

import type { RegistryEntry } from './live.js';
import { pickRegistry } from './live.js';
import type { IsAlive } from './process.js';

/** Enough to climb from claude through a login shell or two to the terminal. */
const MAX_DEPTH = 32;

/** Pid to parent pid, from `ps -A -o pid=,ppid=` (the same flags on macOS and Linux). */
export function parseProcessTable(stdout: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      parents.set(Number(match[1]), Number(match[2]));
    }
  }
  return parents;
}

/** True when pid is one of roots or runs somewhere under one of them. */
export function descendsFrom(
  pid: number,
  parents: ReadonlyMap<number, number>,
  roots: ReadonlySet<number>,
): boolean {
  let current: number | undefined = pid;
  for (let depth = 0; current !== undefined && current > 1 && depth < MAX_DEPTH; depth += 1) {
    if (roots.has(current)) {
      return true;
    }
    current = parents.get(current);
  }
  return false;
}

/** The registry entries whose process is still running, one per session. */
export function liveEntries(
  entries: readonly RegistryEntry[],
  isAlive: IsAlive,
): readonly RegistryEntry[] {
  return [...pickRegistry(entries, isAlive).values()].filter((entry) => isAlive(entry.pid));
}

/**
 * Place each live session. An interactive session counts as VS Code when its
 * process runs under one of the terminal shells, and as a plain terminal
 * otherwise. Kinds other than interactive and background are left out.
 */
export function placeSessions(
  live: readonly RegistryEntry[],
  parents: ReadonlyMap<number, number>,
  terminalPids: ReadonlySet<number>,
): Map<string, SessionPlace> {
  const places = new Map<string, SessionPlace>();
  for (const entry of live) {
    if (entry.kind === 'background') {
      places.set(entry.sessionId, 'background');
    } else if (entry.kind === 'interactive') {
      const inVscode = descendsFrom(entry.pid, parents, terminalPids);
      places.set(entry.sessionId, inVscode ? 'vscode' : 'terminal');
    }
  }
  return places;
}
