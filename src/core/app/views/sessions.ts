// The all-sessions view: every surface, plus each agent observer's sessions
// on disk and the claude.ai export the user imported.

import { CLAUDE_CODE } from '../../../shared/agents.js';
import type { SessionSummary } from '../../../shared/model.js';
import type { SessionsState, SurfaceSession } from '../../../shared/protocol.js';
import { CLAUDE_CAPABILITIES } from '../../agents/claude/capabilities.js';
import { claudeObserverFacet, peekTranscript } from '../../agents/claude/observer.js';
import { observedRow } from '../../agents/shared/session-list.js';
import type {
  ObservedSession,
  AgentPlace,
  ObserverFacet,
  PeekReader,
  ShellEnv,
} from '../../agents/types.js';
import type { ClaudePaths } from '../../paths.js';
import type { OverlordStore } from '../../store/store.js';
import type { ClaudeAiConversation } from '../../surfaces/claude-ai-export.js';
import type { ExecFunction, IsAlive } from '../../surfaces/process.js';
import type { ExtraSource } from '../../surfaces/sessions.js';
import { listAllSessions } from '../../surfaces/sessions.js';
import type { SessionPeek } from '../../transcripts/peek.js';
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
  /** Where observers look for variables that move an agent's folders. */
  readonly env?: ShellEnv;
  readonly exec: ExecFunction;
  readonly isAlive: IsAlive;
  readonly claudeBin: string;
  readonly store: OverlordStore;
  readonly clock: () => number;
  readonly importFile: string;
  readonly report: (source: string, message: string) => void;
  readonly peeks: PeekCache;
  /** The observers whose sessions are listed. Claude's alone when left out. */
  readonly observers?: readonly ObserverFacet[];
}

const SOURCE = 'sessions';

/** Titles and folders of transcripts, reread only when a file changes. */
export class PeekCache {
  private readonly entries = new Map<
    string,
    { readonly key: string; readonly peek: SessionPeek }
  >();

  async get(info: ObservedSession, read: PeekReader = peekTranscript): Promise<SessionPeek> {
    const key = `${String(info.mtimeMs)}:${String(info.size)}`;
    const hit = this.entries.get(info.transcriptPath);
    if (hit?.key === key) {
      return hit.peek;
    }
    const peek = await read(info);
    this.entries.set(info.transcriptPath, { key, peek });
    return peek;
  }
}

/** A Claude transcript on disk as a row, with what the store knows about it when it is live. */
export function transcriptRow(
  info: ObservedSession,
  peek: SessionPeek,
  known?: SessionSummary,
): SurfaceSession {
  return observedRow({ id: CLAUDE_CODE, capabilities: CLAUDE_CAPABILITIES }, info, peek, known);
}

/** One list per agent whose observer can list its sessions. */
function observedSources(deps: SessionsLoadDeps): ExtraSource[] {
  const context: AgentPlace = {
    home: deps.paths.home,
    env: deps.env ?? {},
    claude: deps.paths,
  };
  const sources: ExtraSource[] = [];
  for (const facet of deps.observers ?? [claudeObserverFacet]) {
    const observer = facet.create(context);
    const list = observer.list;
    if (list === undefined) {
      continue;
    }
    sources.push({
      name: observer.source,
      load: async (): Promise<readonly SurfaceSession[]> =>
        list({
          known: new Map(
            deps.store.fleetState(deps.clock()).sessions.map((session) => [session.id, session]),
          ),
          peek: async (info, read) => deps.peeks.get(info, read),
          report: (message) => {
            deps.report(SOURCE, message);
          },
        }),
    });
  }
  return sources;
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
    extraSources: observedSources(deps),
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
