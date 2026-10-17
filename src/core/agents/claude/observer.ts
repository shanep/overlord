// Claude Code's observer: the transcripts under ~/.claude/projects, read by
// the scanner, accumulator and subagent code where they sit in transcripts/.
// Layout:
//   <projectsDir>/<encoded-cwd>/<session-id>.jsonl
//   <projectsDir>/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl

import { CLAUDE_CODE } from '../../../shared/agents.js';
import type { AgentNode, ContextSnapshot, SessionSummary } from '../../../shared/model.js';
import type { SurfaceSession } from '../../../shared/protocol.js';
import { SessionAccumulator } from '../../transcripts/accumulator.js';
import type { SessionPeek } from '../../transcripts/peek.js';
import { peekSession } from '../../transcripts/peek.js';
import type { LoadOptions } from '../../transcripts/scanner.js';
import { scanSessions } from '../../transcripts/scanner.js';
import { parseTranscriptLine } from '../../transcripts/schemas.js';
import { listSubagentFiles, readSubagentMeta } from '../../transcripts/subagents.js';
import { listObserved } from '../shared/session-list.js';
import type {
  ObservedSession,
  ObserverFacet,
  ObserverListInput,
  RecordAccumulator,
  RecordDelta,
  SessionObserver,
  TailedFile,
} from '../types.js';

import { claudeUserPrompts } from './prompts.js';

/** What errors from the Claude watcher and list are filed under. */
const SOURCE = 'transcripts';
const JSONL = '.jsonl';

/** A SessionAccumulator that reads raw lines and picks up subagent meta files as they appear. */
export class ClaudeRecords implements RecordAccumulator {
  readonly inner: SessionAccumulator;

  constructor(inner: SessionAccumulator) {
    this.inner = inner;
  }

  ingest(line: string, agentId: string): RecordDelta | null {
    const record = parseTranscriptLine(line);
    return record === null ? null : this.inner.ingest(record, agentId);
  }

  summary(now: number): SessionSummary {
    return this.inner.summary(now);
  }

  agents(now: number): AgentNode[] {
    return this.inner.agents(now);
  }

  busy(): boolean {
    return this.inner.busy();
  }

  observedContext(agentId: string): ContextSnapshot {
    return this.inner.observedContext(agentId);
  }

  /** A subagent's meta file can land after its transcript, so look again until it is there. */
  async prepare(file: TailedFile): Promise<void> {
    if (file.metaPath !== null && !this.inner.hasSubagentMeta(file.agentId)) {
      const meta = await readSubagentMeta(file.metaPath);
      this.inner.addSubagent(file.agentId, meta, file.path);
    }
  }
}

/** The folder beside a transcript that holds its subagents. */
function sessionDirOf(session: ObservedSession): string {
  return session.transcriptPath.slice(0, -JSONL.length);
}

/** Claude's cheap title and folder read, from the first and last few KB of a transcript. */
export async function peekTranscript(session: ObservedSession): Promise<SessionPeek> {
  return peekSession(session.transcriptPath, session.size);
}

interface ClaudeObserverOptions {
  readonly projectsDir: string;
  /** Prices, windows and limits for each session's accumulator. */
  readonly load?: LoadOptions | undefined;
}

export function claudeObserver(options: ClaudeObserverOptions): SessionObserver<ClaudeRecords> {
  const { projectsDir } = options;
  const load = options.load ?? {};
  return {
    source: SOURCE,
    watchRoot: projectsDir,
    scan: async () => scanSessions(projectsDir),
    childFiles: async (session): Promise<TailedFile[]> => {
      const files = await listSubagentFiles(sessionDirOf(session));
      return files.map((file) => ({
        path: file.transcriptPath,
        agentId: file.agentId,
        metaPath: file.metaPath,
      }));
    },
    makeAccumulator: (session) =>
      new ClaudeRecords(
        new SessionAccumulator({
          ...load,
          sessionId: session.sessionId,
          transcriptPath: session.transcriptPath,
        }),
      ),
    list: async (input: ObserverListInput): Promise<readonly SurfaceSession[]> =>
      listObserved(CLAUDE_CODE, await scanSessions(projectsDir), peekTranscript, input),
  };
}

export const claudeObserverFacet: ObserverFacet = {
  create: (context) => claudeObserver({ projectsDir: context.claude.projectsDir }),
  userPrompts: (context) => claudeUserPrompts(context.claude),
};
