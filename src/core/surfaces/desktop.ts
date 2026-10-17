// Claude Desktop Code tab sessions from claude-code-sessions/. Undocumented,
// read-only, tested against the files Desktop wrote in October 2026. Each one
// names the CLI transcript it drives through cliSessionId.

import path from 'node:path';

import { z } from 'zod';

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { SurfaceSession } from '../../shared/protocol.js';
import { encodeProjectDir } from '../paths.js';
import type { ClaudePaths } from '../paths.js';

import type { Collected } from './common.js';
import { handoffsFor } from './handoff.js';
import { readSessionFiles } from './local-session-files.js';
import { pickTitle } from './title.js';

const desktopSchema = z.object({
  sessionId: z.string().min(1),
  cliSessionId: z.string().min(1).nullish(),
  cwd: z.string().nullish(),
  originCwd: z.string().nullish(),
  title: z.string().nullish(),
  createdAt: z.number(),
  lastActivityAt: z.number().nullish(),
  isArchived: z.boolean().nullish(),
  model: z.string().nullish(),
  permissionMode: z.string().nullish(),
  effort: z.string().nullish(),
  completedTurns: z.number().nullish(),
});

export interface DesktopCodeSession {
  /** Desktop's own id, "local_<uuid>". */
  readonly desktopId: string;
  /** The Claude Code session id, which names the transcript. */
  readonly cliSessionId: string | null;
  readonly cwd: string | null;
  readonly originCwd: string | null;
  readonly title: string | null;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly archived: boolean;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly effort: string | null;
  readonly completedTurns: number | null;
  /** Best guess at the transcript path. See transcriptPathFor. */
  readonly transcriptPath: string | null;
  readonly filePath: string;
}

export function desktopCodeRoot(paths: ClaudePaths): string | null {
  return paths.desktopDir === null ? null : path.join(paths.desktopDir, 'claude-code-sessions');
}

/**
 * Where Claude Code keeps the transcript for a session started in cwd.
 * Project dir names over 200 characters carry a hash we cannot rebuild, so
 * for those this path will not exist and callers should search by prefix.
 */
export function transcriptPathFor(paths: ClaudePaths, cwd: string, sessionId: string): string {
  return path.join(paths.projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

function maybeTranscriptPath(
  paths: ClaudePaths,
  cwd: string | null,
  cliSessionId: string | null,
): string | null {
  return cwd === null || cliSessionId === null ? null : transcriptPathFor(paths, cwd, cliSessionId);
}

function toDesktopSession(
  paths: ClaudePaths,
  filePath: string,
  raw: z.infer<typeof desktopSchema>,
): DesktopCodeSession {
  const cwd = raw.cwd ?? null;
  const cliSessionId = raw.cliSessionId ?? null;
  return {
    desktopId: raw.sessionId,
    cliSessionId,
    cwd,
    originCwd: raw.originCwd ?? null,
    title: raw.title ?? null,
    createdAt: raw.createdAt,
    lastActivityAt: raw.lastActivityAt ?? raw.createdAt,
    archived: raw.isArchived ?? false,
    model: raw.model ?? null,
    permissionMode: raw.permissionMode ?? null,
    effort: raw.effort ?? null,
    completedTurns: raw.completedTurns ?? null,
    transcriptPath: maybeTranscriptPath(paths, cwd, cliSessionId),
    filePath,
  };
}

/** Every Desktop Code session. Always empty on Linux, where Desktop does not run. */
export async function readDesktopCodeSessions(
  paths: ClaudePaths,
): Promise<Collected<DesktopCodeSession>> {
  const root = desktopCodeRoot(paths);
  if (root === null) {
    return { items: [], errors: [] };
  }
  const read = await readSessionFiles(root, desktopSchema, 'desktop-code');
  return {
    items: read.items.map((file) => toDesktopSession(paths, file.filePath, file.data)),
    errors: read.errors,
  };
}

/**
 * The row for a Desktop session. Its id is the CLI session id so it lines up
 * with the transcript and with `claude --resume`. Without one there is
 * nothing to resume, so it gets no handoffs.
 */
export function desktopCodeToSurface(session: DesktopCodeSession): SurfaceSession {
  return {
    id: session.cliSessionId ?? session.desktopId,
    agent: CLAUDE_CODE,
    surface: 'desktop-code',
    title: pickTitle(session.title, session.cwd, 'Desktop session'),
    cwd: session.cwd,
    updatedAt: session.lastActivityAt,
    archived: session.archived,
    handoffs: session.cliSessionId === null ? [] : handoffsFor({ surface: 'desktop-code' }),
  };
}

/** CLI session id to Desktop session id, for every Desktop session that has one. */
export function desktopCliSessionMap(
  sessions: readonly DesktopCodeSession[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const session of sessions) {
    if (session.cliSessionId !== null) {
      map.set(session.cliSessionId, session.desktopId);
    }
  }
  return map;
}
