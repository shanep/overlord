// The all-sessions view: every surface, plus CLI transcripts on disk and the
// claude.ai export the user imported.

import { CLAUDE_CODE } from '../../../shared/agents.js';
import type { SessionSummary } from '../../../shared/model.js';
import type { SessionsState, SurfaceSession } from '../../../shared/protocol.js';
import type { ClaudePaths } from '../../paths.js';
import type { OverlordStore } from '../../store/store.js';
import type { ClaudeAiConversation } from '../../surfaces/claude-ai-export.js';
import { handoffsFor } from '../../surfaces/handoff.js';
import type { ExecFunction, IsAlive } from '../../surfaces/process.js';
import type { ExtraSource } from '../../surfaces/sessions.js';
import { listAllSessions } from '../../surfaces/sessions.js';
import type { SessionPeek } from '../../transcripts/peek.js';
import { peekSession } from '../../transcripts/peek.js';
import type { SessionFileInfo } from '../../transcripts/scanner.js';
import { scanSessions } from '../../transcripts/scanner.js';
import { messageOf } from '../errors.js';
import type { StoredImport } from '../storage.js';
import { readImport } from '../storage.js';

export interface SessionsData {
  readonly sessions: readonly SurfaceSession[];
  readonly importedAt: number | null;
}

export const EMPTY_SESSIONS: SessionsData = { sessions: [], importedAt: null };

export interface SessionsLoadDeps {
  readonly paths: ClaudePaths;
  readonly exec: ExecFunction;
  readonly isAlive: IsAlive;
  readonly claudeBin: string;
  readonly store: OverlordStore;
  readonly clock: () => number;
  readonly importFile: string;
  readonly report: (source: string, message: string) => void;
  readonly peeks: PeekCache;
}

const SOURCE = 'sessions';

/** Titles and folders of transcripts, reread only when a file changes. */
export class PeekCache {
  private readonly entries = new Map<
    string,
    { readonly key: string; readonly peek: SessionPeek }
  >();

  async get(info: SessionFileInfo): Promise<SessionPeek> {
    const key = `${String(info.mtimeMs)}:${String(info.size)}`;
    const hit = this.entries.get(info.transcriptPath);
    if (hit?.key === key) {
      return hit.peek;
    }
    const peek = await peekSession(info.transcriptPath, info.size);
    this.entries.set(info.transcriptPath, { key, peek });
    return peek;
  }
}

const NO_PEEK: SessionPeek = { cwd: null, gitBranch: null, title: null };

/** A transcript on disk as a row, with what the store knows about it when it is live. */
export function transcriptRow(
  info: SessionFileInfo,
  peek: SessionPeek,
  known?: SessionSummary,
): SurfaceSession {
  const surface = known?.surface ?? 'cli';
  return {
    id: info.sessionId,
    agent: known?.agent ?? CLAUDE_CODE,
    surface,
    title: known?.title ?? peek.title ?? `Session ${info.sessionId.slice(0, 8)}`,
    cwd: known?.cwd ?? peek.cwd,
    updatedAt: info.mtimeMs,
    archived: false,
    handoffs: handoffsFor({ surface }),
  };
}

async function peekOrNothing(deps: SessionsLoadDeps, info: SessionFileInfo): Promise<SessionPeek> {
  try {
    return await deps.peeks.get(info);
  } catch (error) {
    deps.report(SOURCE, messageOf(error));
    return NO_PEEK;
  }
}

function transcriptSource(deps: SessionsLoadDeps): ExtraSource {
  return {
    name: 'transcripts',
    load: async (): Promise<readonly SurfaceSession[]> => {
      const known = new Map(
        deps.store.fleetState(deps.clock()).sessions.map((session) => [session.id, session]),
      );
      const files = await scanSessions(deps.paths.projectsDir);
      const rows: SurfaceSession[] = [];
      // One file at a time keeps the first scan of a big history from opening hundreds at once.
      for (const info of files) {
        rows.push(transcriptRow(info, await peekOrNothing(deps, info), known.get(info.sessionId)));
      }
      return rows;
    },
  };
}

function toConversation(session: SurfaceSession): ClaudeAiConversation {
  return { session, createdAt: null, summary: null, messages: [] };
}

async function storedImport(deps: SessionsLoadDeps): Promise<StoredImport | null> {
  try {
    return await readImport(deps.importFile);
  } catch (error) {
    deps.report(SOURCE, messageOf(error));
    return null;
  }
}

export async function loadSessions(deps: SessionsLoadDeps): Promise<SessionsData> {
  const stored = await storedImport(deps);
  const list = await listAllSessions({
    paths: deps.paths,
    exec: deps.exec,
    isAlive: deps.isAlive,
    agentsOptions: { claudeBin: deps.claudeBin },
    claudeAi: (stored?.sessions ?? []).map((session) => toConversation(session)),
    extraSources: [transcriptSource(deps)],
  });
  for (const error of list.errors) {
    deps.report(SOURCE, `${error.source}: ${error.message}`);
  }
  return { sessions: list.sessions, importedAt: stored?.importedAt ?? null };
}

/** Each worktree folder maps to its repository, so its sessions group with the repo. */
export function buildSessions(
  data: SessionsData,
  projectFor: (cwd: string) => string,
): SessionsState {
  const projects: Record<string, string> = {};
  for (const { cwd } of data.sessions) {
    if (cwd !== null) {
      const project = projectFor(cwd);
      if (project !== cwd) {
        projects[cwd] = project;
      }
    }
  }
  return { sessions: data.sessions, claudeAiImportedAt: data.importedAt, projects };
}
