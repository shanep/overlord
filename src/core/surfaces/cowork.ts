// Cowork sessions from local-agent-mode-sessions/. Undocumented, read-only,
// tested against files Desktop wrote in 2026. Each local_<id>.json has a
// sibling local_<id>/ dir holding audit.jsonl and outputs/.

import path from 'node:path';

import { z } from 'zod';

import type { SurfaceSession } from '../../shared/protocol.js';
import type { ClaudePaths } from '../paths.js';

import type { Collected } from './common.js';
import { handoffsFor } from './handoff.js';
import { readSessionFiles } from './local-session-files.js';
import { pickTitle } from './title.js';

// systemPrompt, accountName and emailAddress are in the file too. We leave
// them out on purpose so they never travel further.
const coworkSchema = z.object({
  sessionId: z.string().min(1),
  cliSessionId: z.string().min(1).nullish(),
  processName: z.string().nullish(),
  cwd: z.string().nullish(),
  title: z.string().nullish(),
  createdAt: z.number(),
  lastActivityAt: z.number().nullish(),
  isArchived: z.boolean().nullish(),
  model: z.string().nullish(),
  initialMessage: z.string().nullish(),
});

export interface CoworkSession {
  /** Desktop's id, "local_<uuid>". */
  readonly id: string;
  /** Claude Code session id inside the Cowork VM, when Desktop recorded it. */
  readonly cliSessionId: string | null;
  readonly processName: string | null;
  /** A path inside the Cowork VM, not on this machine. */
  readonly cwd: string | null;
  readonly title: string | null;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly archived: boolean;
  readonly model: string | null;
  readonly initialMessage: string | null;
  readonly auditPath: string;
  readonly outputsDir: string;
  readonly filePath: string;
}

export function coworkRoot(paths: ClaudePaths): string | null {
  return paths.desktopDir === null
    ? null
    : path.join(paths.desktopDir, 'local-agent-mode-sessions');
}

function toCoworkSession(filePath: string, raw: z.infer<typeof coworkSchema>): CoworkSession {
  const sessionDir = filePath.slice(0, -'.json'.length);
  return {
    id: raw.sessionId,
    cliSessionId: raw.cliSessionId ?? null,
    processName: raw.processName ?? null,
    cwd: raw.cwd ?? null,
    title: raw.title ?? null,
    createdAt: raw.createdAt,
    lastActivityAt: raw.lastActivityAt ?? raw.createdAt,
    archived: raw.isArchived ?? false,
    model: raw.model ?? null,
    initialMessage: raw.initialMessage ?? null,
    auditPath: path.join(sessionDir, 'audit.jsonl'),
    outputsDir: path.join(sessionDir, 'outputs'),
    filePath,
  };
}

/** Every Cowork session. Always empty on Linux, where Desktop does not run. */
export async function readCoworkSessions(paths: ClaudePaths): Promise<Collected<CoworkSession>> {
  const root = coworkRoot(paths);
  if (root === null) {
    return { items: [], errors: [] };
  }
  const read = await readSessionFiles(root, coworkSchema, 'cowork');
  return {
    items: read.items.map((file) => toCoworkSession(file.filePath, file.data)),
    errors: read.errors,
  };
}

export function coworkToSurface(session: CoworkSession): SurfaceSession {
  return {
    id: session.id,
    surface: 'cowork',
    title: pickTitle(session.title, null, 'Cowork session'),
    cwd: session.cwd,
    updatedAt: session.lastActivityAt,
    archived: session.archived,
    handoffs: handoffsFor({ surface: 'cowork' }),
  };
}
