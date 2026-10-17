// Every message between agents and sessions under the projects folder. A
// rescan only reads files whose mtime or size changed since the last one, and
// forgets files that are gone. Ids are stable, so nothing is counted twice.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentMessage, MessageRoute } from '../../shared/protocol.js';
import { peekSession } from '../transcripts/peek.js';
import { readAllLines } from '../transcripts/reader.js';
import { scanSessions } from '../transcripts/scanner.js';
import { listSubagentFiles, readSubagentMeta } from '../transcripts/subagents.js';

import type { ExtractedMessage, FileContext } from './extract.js';
import { extractMessages, MAIN } from './extract.js';
import type { Directory } from './names.js';
import { nameMessages } from './names.js';

export const DEFAULT_MESSAGE_LIMIT = 500;

export interface MessageScan {
  /** Newest first, at most the index's limit. */
  readonly messages: readonly AgentMessage[];
  /** Between sessions, busiest first. */
  readonly routes: readonly MessageRoute[];
}

export interface MessageIndexOptions {
  readonly projectsDir: string;
  readonly limit?: number;
}

interface FileFacts {
  /** Who launched the owner. */
  readonly parent: string;
  /** The session's title for a main transcript, the agent's description for a subagent's. */
  readonly label: string | null;
}

interface FileTarget {
  readonly file: string;
  readonly sessionId: string;
  readonly owner: string;
  /** Only called when the file changed. */
  readonly facts: (size: number) => Promise<FileFacts>;
}

interface CachedFile extends FileFacts {
  readonly sessionId: string;
  readonly owner: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly messages: readonly ExtractedMessage[];
}

async function sizeAndTime(file: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const info = await stat(file);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
}

/** The session's title, or the folder it ran in until it has one. */
async function sessionTitle(file: string, size: number): Promise<string | null> {
  try {
    const peek = await peekSession(file, size);
    return peek.title ?? (peek.cwd === null ? null : path.basename(peek.cwd));
  } catch {
    return null;
  }
}

function mainFacts(transcriptPath: string): (size: number) => Promise<FileFacts> {
  return async (size) => ({ parent: MAIN, label: await sessionTitle(transcriptPath, size) });
}

async function targets(projectsDir: string): Promise<FileTarget[]> {
  const found: FileTarget[] = [];
  for (const session of await scanSessions(projectsDir)) {
    const { sessionId, transcriptPath } = session;
    found.push({ file: transcriptPath, sessionId, owner: MAIN, facts: mainFacts(transcriptPath) });
    for (const sub of await listSubagentFiles(session.sessionDir)) {
      const subFacts = async (): Promise<FileFacts> => {
        const meta = await readSubagentMeta(sub.metaPath);
        const id = meta?.parentAgentId ?? sessionId;
        const description = meta?.description ?? '';
        const label = description === '' ? (meta?.agentType ?? null) : description;
        return { parent: id === sessionId ? MAIN : id, label };
      };
      found.push({ file: sub.transcriptPath, sessionId, owner: sub.agentId, facts: subFacts });
    }
  }
  return found;
}

function compareMessages(left: AgentMessage, right: AgentMessage): number {
  if (left.at !== right.at) {
    return right.at - left.at;
  }
  return left.id.localeCompare(right.id);
}

export class MessageIndex {
  private readonly files = new Map<string, CachedFile>();
  private readonly limit: number;

  constructor(private readonly options: MessageIndexOptions) {
    this.limit = options.limit ?? DEFAULT_MESSAGE_LIMIT;
  }

  /** How many transcript files the last scan kept. */
  get fileCount(): number {
    return this.files.size;
  }

  /** Rescans. `liveTitles` are the fleet's titles, newer than any in a transcript. */
  async scan(liveTitles: ReadonlyMap<string, string> = new Map()): Promise<MessageScan> {
    const seen = new Set<string>();
    for (const target of await targets(this.options.projectsDir)) {
      if (await this.load(target)) {
        seen.add(target.file);
      }
    }
    for (const file of this.files.keys()) {
      if (!seen.has(file)) {
        this.files.delete(file);
      }
    }
    return this.snapshot(liveTitles);
  }

  private async load(target: FileTarget): Promise<boolean> {
    const info = await sizeAndTime(target.file);
    if (info === null) {
      return false;
    }
    const cached = this.files.get(target.file);
    if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return true;
    }
    const facts = await target.facts(info.size);
    const context: FileContext = {
      sessionId: target.sessionId,
      owner: target.owner,
      parent: facts.parent,
    };
    const messages = extractMessages(await readAllLines(target.file), context);
    this.files.set(target.file, {
      ...info,
      ...facts,
      sessionId: target.sessionId,
      owner: target.owner,
      messages,
    });
    return true;
  }

  private directory(liveTitles: ReadonlyMap<string, string>): Directory {
    const labels = new Map<string, string>();
    for (const cached of this.files.values()) {
      if (cached.label !== null) {
        labels.set(`${cached.sessionId}\n${cached.owner}`, cached.label);
      }
    }
    const titleOf = (sessionId: string): string =>
      liveTitles.get(sessionId) ??
      labels.get(`${sessionId}\n${MAIN}`) ??
      `Session ${sessionId.slice(0, 8)}`;
    const uses = new Map<string, number>();
    for (const sessionId of new Set([...this.files.values()].map((file) => file.sessionId))) {
      const title = titleOf(sessionId);
      uses.set(title, (uses.get(title) ?? 0) + 1);
    }
    return {
      // Sessions in one folder share its name until they get titles, so add the id.
      sessionTitle: (sessionId): string => {
        const title = titleOf(sessionId);
        return (uses.get(title) ?? 0) > 1 ? `${title} (${sessionId.slice(0, 8)})` : title;
      },
      agentName: (sessionId, agentId) =>
        agentId === MAIN ? null : (labels.get(`${sessionId}\n${agentId}`) ?? null),
    };
  }

  private snapshot(liveTitles: ReadonlyMap<string, string>): MessageScan {
    const unique = new Map<string, ExtractedMessage>();
    for (const cached of this.files.values()) {
      for (const entry of cached.messages) {
        unique.set(entry.message.id, entry);
      }
    }
    const named = nameMessages([...unique.values()], this.directory(liveTitles));
    return {
      messages: named.messages.toSorted(compareMessages).slice(0, this.limit),
      routes: named.routes,
    };
  }
}
