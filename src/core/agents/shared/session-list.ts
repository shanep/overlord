// An agent's sessions on disk as rows for the all-sessions list. An observer
// gives its scan and a cheap peek at each file, and the fleet fills in what it
// already knows about the live ones.

import type { AgentId } from '../../../shared/agents.js';
import type { SessionSummary } from '../../../shared/model.js';
import type { SurfaceSession } from '../../../shared/protocol.js';
import { handoffsFor } from '../../surfaces/handoff.js';
import type { SessionPeek } from '../../transcripts/peek.js';
import type { ObservedSession, ObserverListInput, PeekReader } from '../types.js';

const NO_PEEK: SessionPeek = { cwd: null, gitBranch: null, title: null };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A session on disk as a row, with what the store knows about it when it is live. */
export function observedRow(
  agent: AgentId,
  info: ObservedSession,
  peek: SessionPeek,
  known?: SessionSummary,
): SurfaceSession {
  const surface = known?.surface ?? 'cli';
  return {
    id: info.sessionId,
    agent: known?.agent ?? agent,
    surface,
    title: known?.title ?? peek.title ?? `Session ${info.sessionId.slice(0, 8)}`,
    cwd: known?.cwd ?? peek.cwd,
    updatedAt: info.mtimeMs,
    archived: false,
    handoffs: handoffsFor({ surface }),
  };
}

async function peekOrNothing(
  input: ObserverListInput,
  info: ObservedSession,
  read: PeekReader,
): Promise<SessionPeek> {
  try {
    return await input.peek(info, read);
  } catch (error) {
    input.report(messageOf(error));
    return NO_PEEK;
  }
}

/** Every scanned session as a row. A file that cannot be peeked still gets one. */
export async function listObserved(
  agent: AgentId,
  sessions: readonly ObservedSession[],
  read: PeekReader,
  input: ObserverListInput,
): Promise<SurfaceSession[]> {
  const rows: SurfaceSession[] = [];
  // One file at a time keeps the first scan of a big history from opening hundreds at once.
  for (const info of sessions) {
    rows.push(
      observedRow(
        agent,
        info,
        await peekOrNothing(input, info, read),
        input.known.get(info.sessionId),
      ),
    );
  }
  return rows;
}
