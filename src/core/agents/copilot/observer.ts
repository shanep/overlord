// Copilot CLI's observer: the sessions under $COPILOT_HOME (default
// ~/.copilot). Layout:
//   <home>/session-state/<session-id>/events.jsonl
//   <home>/session-state/<session-id>/workspace.yaml
// Subagent events sit in the same events.jsonl, named by their agentId, so
// there are no child files.

import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { COPILOT } from '../../../shared/agents.js';
import type { SurfaceSession } from '../../../shared/protocol.js';
import type { SessionPeek } from '../../transcripts/peek.js';
import { listObserved } from '../shared/session-list.js';
import type {
  ObservedSession,
  ObserverContext,
  ObserverFacet,
  ObserverListInput,
  SessionObserver,
  TailedFile,
} from '../types.js';

import { CopilotRecords } from './accumulator.js';
import { readWorkspace, WORKSPACE_FILE } from './workspace.js';

/** What errors from the Copilot watcher and list are filed under. */
const SOURCE = 'copilot';
const EVENTS_FILE = 'events.jsonl';

/** Copilot's home: COPILOT_HOME when set, else ~/.copilot. */
export function copilotHome(context: Pick<ObserverContext, 'home' | 'env'>): string {
  const set = context.env['COPILOT_HOME']?.trim() ?? '';
  return set === '' ? path.join(context.home, '.copilot') : set;
}

function workspaceOf(session: ObservedSession): string {
  return path.join(path.dirname(session.transcriptPath), WORKSPACE_FILE);
}

async function sessionAt(dir: string, sessionId: string): Promise<ObservedSession | null> {
  const transcriptPath = path.join(dir, sessionId, EVENTS_FILE);
  try {
    const info = await stat(transcriptPath);
    return info.isFile()
      ? { sessionId, transcriptPath, mtimeMs: info.mtimeMs, size: info.size }
      : null;
  } catch {
    return null;
  }
}

/** Every session folder that has an events.jsonl, newest first. A missing folder has none. */
export async function scanCopilotSessions(stateDir: string): Promise<ObservedSession[]> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch {
    return [];
  }
  const found = await Promise.all(names.map(async (name) => sessionAt(stateDir, name)));
  return found
    .filter((session): session is ObservedSession => session !== null)
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs);
}

/** Title, folder and branch from workspace.yaml, which is small, so no events are read. */
async function peekWorkspace(session: ObservedSession): Promise<SessionPeek> {
  const workspace = await readWorkspace(workspaceOf(session));
  return {
    cwd: workspace?.cwd ?? null,
    gitBranch: workspace?.branch ?? null,
    title: workspace?.name ?? null,
  };
}

export function copilotObserver(home: string): SessionObserver<CopilotRecords> {
  const stateDir = path.join(home, 'session-state');
  return {
    source: SOURCE,
    // fs.watch throws on a folder that is not there, and polling finds it once Copilot makes it.
    watchRoot: existsSync(stateDir) ? stateDir : null,
    scan: async () => scanCopilotSessions(stateDir),
    childFiles: async (): Promise<TailedFile[]> => {
      await Promise.resolve();
      return [];
    },
    makeAccumulator: (session) =>
      new CopilotRecords({
        sessionId: session.sessionId,
        transcriptPath: session.transcriptPath,
        workspacePath: workspaceOf(session),
      }),
    list: async (input: ObserverListInput): Promise<readonly SurfaceSession[]> => {
      const rows = await listObserved(
        COPILOT,
        await scanCopilotSessions(stateDir),
        peekWorkspace,
        input,
      );
      // Resume, desktop and teleport are Claude's. Copilot gets its own in milestone 2.
      return rows.map((row) => ({ ...row, handoffs: [] }));
    },
  };
}

export const copilotObserverFacet: ObserverFacet = {
  create: (context) => copilotObserver(copilotHome(context)),
};
