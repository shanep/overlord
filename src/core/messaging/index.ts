// Every message between agents and sessions under the projects folder. A
// rescan only reads files whose mtime or size changed since the last one, and
// forgets files that are gone. Ids are stable, so nothing is counted twice.

import { stat } from 'node:fs/promises';

import type { AgentMessage, MessageRoute } from '../../shared/protocol.js';
import { readAllLines } from '../transcripts/reader.js';
import { scanSessions } from '../transcripts/scanner.js';
import { listSubagentFiles, readSubagentMeta } from '../transcripts/subagents.js';

import type { ExtractedMessage, FileContext } from './extract.js';
import { extractMessages, MAIN } from './extract.js';

export const DEFAULT_MESSAGE_LIMIT = 500;

export interface MessageScan {
  /** Newest first, at most the index's limit. */
  readonly messages: readonly AgentMessage[];
  /** Busiest first. */
  readonly routes: readonly MessageRoute[];
}

export interface MessageIndexOptions {
  readonly projectsDir: string;
  readonly limit?: number;
}

interface FileTarget {
  readonly file: string;
  readonly sessionId: string;
  readonly owner: string;
  /** Reads who launched the owner. Only called when the file changed. */
  readonly parent: () => Promise<string>;
}

interface CachedFile {
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

async function mainParent(): Promise<string> {
  await Promise.resolve();
  return MAIN;
}

async function targets(projectsDir: string): Promise<FileTarget[]> {
  const found: FileTarget[] = [];
  for (const session of await scanSessions(projectsDir)) {
    const { sessionId } = session;
    found.push({ file: session.transcriptPath, sessionId, owner: MAIN, parent: mainParent });
    for (const sub of await listSubagentFiles(session.sessionDir)) {
      const parent = async (): Promise<string> => {
        const meta = await readSubagentMeta(sub.metaPath);
        const id = meta?.parentAgentId ?? sessionId;
        return id === sessionId ? MAIN : id;
      };
      found.push({ file: sub.transcriptPath, sessionId, owner: sub.agentId, parent });
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

function compareRoutes(left: MessageRoute, right: MessageRoute): number {
  if (left.count !== right.count) {
    return right.count - left.count;
  }
  return right.lastAt - left.lastAt;
}

/**
 * Routes from every message, except deliveries whose text matches a send
 * already seen, since the send and its delivery are the same message.
 */
export function buildRoutes(entries: readonly ExtractedMessage[]): MessageRoute[] {
  const sent = new Set(
    entries.flatMap((entry) => (entry.message.kind === 'send' ? [entry.textKey] : [])),
  );
  const routes = new Map<string, MessageRoute>();
  for (const { message, textKey } of entries) {
    if (message.kind === 'receive' && sent.has(textKey)) {
      continue;
    }
    const key = JSON.stringify([message.from, message.to]);
    const old = routes.get(key);
    routes.set(key, {
      from: message.from,
      to: message.to,
      count: (old?.count ?? 0) + 1,
      lastAt: Math.max(old?.lastAt ?? 0, message.at),
    });
  }
  return [...routes.values()].toSorted(compareRoutes);
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

  async scan(): Promise<MessageScan> {
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
    return this.snapshot();
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
    const context: FileContext = {
      sessionId: target.sessionId,
      owner: target.owner,
      parent: await target.parent(),
    };
    const messages = extractMessages(await readAllLines(target.file), context);
    this.files.set(target.file, { ...info, messages });
    return true;
  }

  private snapshot(): MessageScan {
    const unique = new Map<string, ExtractedMessage>();
    for (const cached of this.files.values()) {
      for (const entry of cached.messages) {
        unique.set(entry.message.id, entry);
      }
    }
    const entries = [...unique.values()];
    return {
      messages: entries
        .map((entry) => entry.message)
        .toSorted(compareMessages)
        .slice(0, this.limit),
      routes: buildRoutes(entries),
    };
  }
}
