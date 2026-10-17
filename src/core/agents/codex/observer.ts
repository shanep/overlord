// Codex's observer: the rollout files under $CODEX_HOME/sessions (default
// ~/.codex). Layout:
//   <codexHome>/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl
// Codex keeps its thread list in state_5.sqlite, but every rollout starts
// with a session_meta line, so the files alone are enough to list sessions.
// cspell:words rollouts

import { existsSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { CODEX } from '../../../shared/agents.js';
import { plainText } from '../../../shared/plain-text.js';
import type { SurfaceSession } from '../../../shared/protocol.js';
import { agentHome } from '../../context/policy.js';
import type { SessionPeek } from '../../transcripts/peek.js';
import { listObserved } from '../shared/session-list.js';
import type {
  ObservedSession,
  AgentPlace,
  ObserverFacet,
  ObserverListInput,
  SessionObserver,
  TailedFile,
} from '../types.js';

import { CodexRecords } from './accumulator.js';
import { CODEX_CAPABILITIES } from './capabilities.js';
import { parseRolloutLine, partsText } from './records.js';

/** What errors from the Codex watcher and list are filed under. */
const SOURCE = 'codex rollouts';

/** The session_meta line alone runs about 20 KB, and the first prompt follows a few developer messages. */
const PEEK_BYTES = 192 * 1024;
const TITLE_CHARS = 120;

const ROLLOUT =
  /^rollout-.+-(?<id>[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.jsonl$/u;

/** Where Codex keeps its files: CODEX_HOME, or ~/.codex. */
export function codexHome(context: Pick<AgentPlace, 'home' | 'env'>): string {
  return agentHome(context, 'CODEX_HOME', '.codex');
}

/** The thread id in a rollout file name, or null when the name is not a rollout. */
export function rolloutId(fileName: string): string | null {
  return ROLLOUT.exec(fileName)?.groups?.['id'] ?? null;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Every rollout under sessionsDir, newest first. A missing folder means Codex never ran here. */
export async function scanRollouts(sessionsDir: string): Promise<ObservedSession[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir, { recursive: true });
  } catch (error: unknown) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  const found: ObservedSession[] = [];
  for (const entry of entries) {
    const sessionId = rolloutId(path.basename(entry));
    if (sessionId === null) {
      continue;
    }
    const file = path.join(sessionsDir, entry);
    try {
      const info = await stat(file);
      found.push({ sessionId, transcriptPath: file, mtimeMs: info.mtimeMs, size: info.size });
    } catch (error: unknown) {
      // Codex archives or deletes a rollout between the listing and the stat.
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
  return found.toSorted((left, right) => right.mtimeMs - left.mtimeMs);
}

async function readHead(file: string, length: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Folder, branch and first prompt from the start of a rollout, for the all-sessions list. */
export async function peekRollout(session: ObservedSession): Promise<SessionPeek> {
  const text = await readHead(session.transcriptPath, Math.min(session.size, PEEK_BYTES));
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  for (const line of text.split('\n')) {
    const record = parseRolloutLine(line);
    if (record?.kind === 'session_meta') {
      cwd = record.meta.cwd ?? null;
      gitBranch = record.meta.git?.branch ?? null;
    } else if (record?.kind === 'item' && record.completed.item.type === 'UserMessage') {
      const prompt = plainText(partsText(record.completed.item.content))
        .replaceAll(/\s+/gu, ' ')
        .trim();
      if (prompt !== '') {
        return { cwd, gitBranch, title: prompt.slice(0, TITLE_CHARS) };
      }
    }
  }
  return { cwd, gitBranch, title: null };
}

export function codexObserver(
  context: Pick<AgentPlace, 'home' | 'env'>,
): SessionObserver<CodexRecords> {
  const sessionsDir = path.join(codexHome(context), 'sessions');
  return {
    source: SOURCE,
    // fs.watch throws on a missing folder, and polling finds it if Codex runs later.
    watchRoot: existsSync(sessionsDir) ? sessionsDir : null,
    scan: async () => scanRollouts(sessionsDir),
    childFiles: async (): Promise<readonly TailedFile[]> => {
      // Codex keeps a thread in one file.
      await Promise.resolve();
      return [];
    },
    makeAccumulator: (session) =>
      new CodexRecords({ sessionId: session.sessionId, transcriptPath: session.transcriptPath }),
    list: async (input: ObserverListInput): Promise<readonly SurfaceSession[]> =>
      listObserved(
        { id: CODEX, capabilities: CODEX_CAPABILITIES },
        await scanRollouts(sessionsDir),
        peekRollout,
        input,
      ),
  };
}

export const codexObserverFacet: ObserverFacet = {
  create: (context) => codexObserver(context),
};
