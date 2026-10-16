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
    // Lines may carry the command after the two pids (ps -o args=).
    const match = /^\s*(\d+)\s+(\d+)(?:\s|$)/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      parents.set(Number(match[1]), Number(match[2]));
    }
  }
  return parents;
}

/** A `claude attach <id>` client: a terminal showing a background session. */
export interface AttachClient {
  readonly pid: number;
  /** The session id, or the start of it, that the client attached to. */
  readonly target: string;
}

const ATTACH = /^\s*(\d+)\s+\d+\s+\S*claude\s+attach\s+([\w-]+)/u;

/** Attach clients from `ps -A -o pid=,ppid=,args=`. */
export function parseAttachClients(stdout: string): readonly AttachClient[] {
  const clients: AttachClient[] = [];
  for (const line of stdout.split('\n')) {
    const match = ATTACH.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      clients.push({ pid: Number(match[1]), target: match[2] });
    }
  }
  return clients;
}

/** The root that pid is, or runs somewhere under, or null when it is under none of them. */
export function rootOf(
  pid: number,
  parents: ReadonlyMap<number, number>,
  roots: ReadonlySet<number>,
): number | null {
  let current: number | undefined = pid;
  for (let depth = 0; current !== undefined && current > 1 && depth < MAX_DEPTH; depth += 1) {
    if (roots.has(current)) {
      return current;
    }
    current = parents.get(current);
  }
  return null;
}

export interface Placement {
  readonly place: SessionPlace;
  /** The terminal's shell pid, for a session in a VS Code terminal. */
  readonly terminal: number | null;
}

/** The registry entries whose process is still running, one per session. */
export function liveEntries(
  entries: readonly RegistryEntry[],
  isAlive: IsAlive,
): readonly RegistryEntry[] {
  return [...pickRegistry(entries, isAlive).values()].filter((entry) => isAlive(entry.pid));
}

/** Ids shorter than this are too vague to tie a client to a session. */
const MIN_TARGET = 8;

/** True when the client shows this session. */
export function attachesTo(client: AttachClient, sessionId: string): boolean {
  return client.target.length >= MIN_TARGET && sessionId.startsWith(client.target);
}

/** The VS Code terminal showing a background session through `claude attach`, or null. */
function attachedTerminal(
  sessionId: string,
  attaches: readonly AttachClient[],
  context: { readonly parents: ReadonlyMap<number, number>; readonly roots: ReadonlySet<number> },
): number | null {
  for (const client of attaches) {
    if (attachesTo(client, sessionId)) {
      const terminal = rootOf(client.pid, context.parents, context.roots);
      if (terminal !== null) {
        return terminal;
      }
    }
  }
  return null;
}

/**
 * Place each live session. An interactive session counts as VS Code when its
 * process runs under one of the terminal shells, and as a plain terminal
 * otherwise. A background session counts as VS Code when one of those
 * terminals runs `claude attach` for it, since that tab is where it shows.
 * Kinds other than interactive and background are left out.
 */
export function placeSessions(
  live: readonly RegistryEntry[],
  parents: ReadonlyMap<number, number>,
  terminalPids: ReadonlySet<number>,
  attaches: readonly AttachClient[] = [],
): Map<string, Placement> {
  const places = new Map<string, Placement>();
  const context = { parents, roots: terminalPids };
  for (const entry of live) {
    if (entry.kind === 'background') {
      const terminal = attachedTerminal(entry.sessionId, attaches, context);
      places.set(entry.sessionId, { place: terminal === null ? 'background' : 'vscode', terminal });
    } else if (entry.kind === 'interactive') {
      const terminal = rootOf(entry.pid, parents, terminalPids);
      places.set(entry.sessionId, { place: terminal === null ? 'terminal' : 'vscode', terminal });
    }
  }
  return places;
}
