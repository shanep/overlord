// One list of sessions across every surface. Each source runs on its own, so
// a broken Desktop file or a missing claude binary only adds an error.

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { Surface } from '../../shared/model.js';
import type { SurfaceSession } from '../../shared/protocol.js';
import type { ClaudePaths } from '../paths.js';

import type { ClaudeAiConversation } from './claude-ai-export.js';
import { sourceError } from './common.js';
import type { Collected, SourceError } from './common.js';
import { coworkToSurface, readCoworkSessions } from './cowork.js';
import type { CoworkSession } from './cowork.js';
import { desktopCliSessionMap, desktopCodeToSurface, readDesktopCodeSessions } from './desktop.js';
import type { DesktopCodeSession } from './desktop.js';
import { handoffsFor } from './handoff.js';
import { buildLiveProcessTable } from './live.js';
import type { AgentsOptions, LiveProcess } from './live.js';
import type { ExecFunction, IsAlive } from './process.js';
import { pickTitle } from './title.js';

export interface ExtraSource {
  /** Shows up in errors, for example "transcripts" or "cloud". */
  readonly name: string;
  readonly load: () => Promise<readonly SurfaceSession[]>;
}

export interface SessionListDeps {
  readonly paths: ClaudePaths;
  readonly exec: ExecFunction;
  readonly isAlive: IsAlive;
  readonly agentsOptions?: AgentsOptions | undefined;
  /** Chats from a claude.ai export the user imported earlier. */
  readonly claudeAi?: readonly ClaudeAiConversation[];
  /** Other lists, such as transcript-backed CLI sessions or cloud sessions. */
  readonly extraSources?: readonly ExtraSource[];
}

export interface SessionList {
  /** Newest first, one row per session. */
  readonly sessions: readonly SurfaceSession[];
  readonly live: ReadonlyMap<string, LiveProcess>;
  readonly desktop: readonly DesktopCodeSession[];
  readonly cowork: readonly CoworkSession[];
  /** CLI session id to Desktop session id. */
  readonly desktopByCliSession: ReadonlyMap<string, string>;
  readonly errors: readonly SourceError[];
}

/** Which surface a live process belongs to, from its registry entrypoint. */
export function surfaceForEntrypoint(entrypoint: string | null): Surface {
  if (entrypoint === null) {
    return 'cli';
  }
  if (entrypoint.startsWith('sdk')) {
    return 'sdk';
  }
  return entrypoint === 'claude-desktop' ? 'desktop-code' : 'cli';
}

export function liveToSurface(live: LiveProcess): SurfaceSession {
  const surface = surfaceForEntrypoint(live.entrypoint);
  return {
    id: live.sessionId,
    agent: CLAUDE_CODE,
    surface,
    title: pickTitle(live.name, live.cwd, live.sessionId),
    cwd: live.cwd,
    updatedAt: live.updatedAt ?? live.startedAt ?? 0,
    archived: false,
    handoffs: handoffsFor({ surface }),
  };
}

// When two sources describe one session, the more specific surface wins:
// a Desktop row says more than the CLI transcript it drives.
const SURFACE_RANK: Readonly<Record<Surface, number>> = {
  cli: 1,
  sdk: 2,
  overlord: 3,
  cloud: 4,
  cowork: 5,
  'desktop-code': 6,
  'claude-ai': 7,
};

function mergePair(a: SurfaceSession, b: SurfaceSession): SurfaceSession {
  const [winner, loser] = SURFACE_RANK[b.surface] > SURFACE_RANK[a.surface] ? [b, a] : [a, b];
  return {
    ...winner,
    cwd: winner.cwd ?? loser.cwd,
    updatedAt: Math.max(winner.updatedAt, loser.updatedAt),
  };
}

/**
 * Collapse rows that are the same session. `aliases` maps another id (such as
 * a Cowork session's CLI session id) to the row id it belongs to.
 */
export function dedupeSessions(
  sessions: readonly SurfaceSession[],
  aliases: ReadonlyMap<string, string> = new Map(),
): SurfaceSession[] {
  const byKey = new Map<string, SurfaceSession>();
  for (const session of sessions) {
    const key = aliases.get(session.id) ?? session.id;
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? session : mergePair(existing, session));
  }
  return [...byKey.values()].toSorted(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
}

async function safely<T>(name: string, load: () => Promise<Collected<T>>): Promise<Collected<T>> {
  try {
    return await load();
  } catch (error) {
    return { items: [], errors: [sourceError(name, error, null)] };
  }
}

async function loadExtras(sources: readonly ExtraSource[]): Promise<Collected<SurfaceSession>> {
  const results = await Promise.all(
    sources.map(async (source) =>
      safely(source.name, async () => ({ items: await source.load(), errors: [] })),
    ),
  );
  return {
    items: results.flatMap((result) => result.items),
    errors: results.flatMap((result) => result.errors),
  };
}

function coworkAliases(cowork: readonly CoworkSession[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const session of cowork) {
    if (session.cliSessionId !== null) {
      aliases.set(session.cliSessionId, session.id);
    }
  }
  return aliases;
}

/** Every session from every source, deduped and sorted newest first. */
export async function listAllSessions(deps: SessionListDeps): Promise<SessionList> {
  const [live, desktop, cowork, extras] = await Promise.all([
    buildLiveProcessTable({
      paths: deps.paths,
      exec: deps.exec,
      isAlive: deps.isAlive,
      options: deps.agentsOptions,
    }),
    // These two report their own failures and never throw.
    readDesktopCodeSessions(deps.paths),
    readCoworkSessions(deps.paths),
    loadExtras(deps.extraSources ?? []),
  ]);
  const rows: SurfaceSession[] = [
    ...[...live.processes.values()].map((process) => liveToSurface(process)),
    ...extras.items,
    ...desktop.items.map((session) => desktopCodeToSurface(session)),
    ...cowork.items.map((session) => coworkToSurface(session)),
    ...(deps.claudeAi ?? []).map((conversation) => conversation.session),
  ];
  return {
    sessions: dedupeSessions(rows, coworkAliases(cowork.items)),
    live: live.processes,
    desktop: desktop.items,
    cowork: cowork.items,
    desktopByCliSession: desktopCliSessionMap(desktop.items),
    errors: [...live.errors, ...desktop.errors, ...cowork.errors, ...extras.errors],
  };
}
