// Importer for the claude.ai data export (Settings, Privacy, Export data).
// Anthropic does not publish the schema. The shape below comes from exports
// seen in the wild: conversations.json holds an array of conversations with
// uuid, name, created_at, updated_at and chat_messages[], and each message has
// uuid, sender ("human" or "assistant"), text, content[] blocks and
// created_at. Every field is optional here so a format change degrades to
// missing data instead of a failed import.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { SurfaceSession } from '../../shared/protocol.js';

import { lenientArray, sourceError } from './common.js';
import type { SourceError } from './common.js';

const CONVERSATIONS_FILE = 'conversations.json';

const contentBlockSchema = z.object({
  type: z.string().nullish(),
  text: z.string().nullish(),
});

const messageSchema = z.object({
  uuid: z.string().nullish(),
  sender: z.string().nullish(),
  text: z.string().nullish(),
  content: lenientArray(contentBlockSchema).nullish(),
  created_at: z.string().nullish(),
  attachments: lenientArray(z.object({ file_name: z.string() })).nullish(),
  files: lenientArray(z.object({ file_name: z.string() })).nullish(),
});

const conversationSchema = z.object({
  uuid: z.string().min(1),
  name: z.string().nullish(),
  summary: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  chat_messages: lenientArray(messageSchema).nullish(),
});

const topLevelSchema = z.union([
  z.array(z.unknown()),
  z.object({ conversations: z.array(z.unknown()) }).transform((value) => value.conversations),
]);

type ClaudeAiSender = 'human' | 'assistant' | 'other';

interface ClaudeAiMessage {
  readonly id: string | null;
  readonly sender: ClaudeAiSender;
  readonly text: string;
  readonly createdAt: number | null;
  /** File names of attachments and uploads. */
  readonly attachments: readonly string[];
}

export interface ClaudeAiConversation {
  readonly session: SurfaceSession;
  readonly createdAt: number | null;
  readonly summary: string | null;
  readonly messages: readonly ClaudeAiMessage[];
}

export interface ClaudeAiImport {
  readonly conversations: readonly ClaudeAiConversation[];
  readonly errors: readonly SourceError[];
  readonly importedAt: number;
  /** The conversations.json that was read, or null when none was found. */
  readonly sourcePath: string | null;
}

export interface ImportOptions {
  readonly now?: () => number;
}

const SOURCE = 'claude-ai-export';

function parseTime(value: string | null | undefined): number | null {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : ms;
}

function toSender(sender: string | null | undefined): ClaudeAiSender {
  if (sender === 'human' || sender === 'user') {
    return 'human';
  }
  return sender === 'assistant' ? 'assistant' : 'other';
}

type RawMessage = z.infer<typeof messageSchema>;

// Newer exports leave `text` empty and put the words in content blocks.
function messageText(raw: RawMessage): string {
  const text = raw.text ?? '';
  if (text.trim() !== '') {
    return text;
  }
  const blocks = raw.content ?? [];
  return blocks
    .filter((block) => (block.type ?? 'text') === 'text')
    .map((block) => block.text ?? '')
    .filter((part) => part !== '')
    .join('\n\n');
}

function toMessage(raw: RawMessage): ClaudeAiMessage {
  const files = [...(raw.attachments ?? []), ...(raw.files ?? [])];
  return {
    id: raw.uuid ?? null,
    sender: toSender(raw.sender),
    text: messageText(raw),
    createdAt: parseTime(raw.created_at),
    attachments: files.map((file) => file.file_name),
  };
}

function latestMessageTime(messages: readonly ClaudeAiMessage[]): number | null {
  const times = messages.flatMap((message) =>
    message.createdAt === null ? [] : [message.createdAt],
  );
  return times.length === 0 ? null : Math.max(...times);
}

function toConversation(raw: z.infer<typeof conversationSchema>): ClaudeAiConversation {
  const messages = (raw.chat_messages ?? []).map((message) => toMessage(message));
  const createdAt = parseTime(raw.created_at);
  const name = raw.name?.trim() ?? '';
  return {
    session: {
      id: raw.uuid,
      agent: CLAUDE_CODE,
      surface: 'claude-ai',
      title: name === '' ? 'Untitled chat' : name,
      cwd: null,
      updatedAt: parseTime(raw.updated_at) ?? latestMessageTime(messages) ?? createdAt ?? 0,
      archived: false,
      handoffs: [],
    },
    createdAt,
    summary: raw.summary ?? null,
    messages,
  };
}

export interface ParsedExport {
  readonly conversations: readonly ClaudeAiConversation[];
  readonly errors: readonly SourceError[];
}

/** Parse the JSON of conversations.json. Bad entries are reported by index, never by content. */
export function parseClaudeAiExport(json: unknown): ParsedExport {
  const top = topLevelSchema.safeParse(json);
  if (!top.success) {
    return {
      conversations: [],
      errors: [{ source: SOURCE, message: 'expected an array of conversations', path: null }],
    };
  }
  const conversations: ClaudeAiConversation[] = [];
  const errors: SourceError[] = [];
  for (const [index, raw] of top.data.entries()) {
    const parsed = conversationSchema.safeParse(raw);
    if (parsed.success) {
      conversations.push(toConversation(parsed.data));
    } else {
      errors.push({ source: SOURCE, message: `conversation ${String(index)} skipped`, path: null });
    }
  }
  return { conversations, errors };
}

async function findInDir(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === CONVERSATIONS_FILE)) {
    return path.join(dir, CONVERSATIONS_FILE);
  }
  // Unzipping often adds one wrapper folder.
  const children = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b));
  for (const child of children) {
    const inner = await readdir(path.join(dir, child), { withFileTypes: true });
    if (inner.some((entry) => entry.isFile() && entry.name === CONVERSATIONS_FILE)) {
      return path.join(dir, child, CONVERSATIONS_FILE);
    }
  }
  return null;
}

/** Find conversations.json given the file itself or an unzipped export folder. */
export async function resolveExportFile(inputPath: string): Promise<string> {
  const info = await stat(inputPath);
  if (info.isDirectory()) {
    const found = await findInDir(inputPath);
    if (found === null) {
      throw new Error(`no ${CONVERSATIONS_FILE} in this folder`);
    }
    return found;
  }
  if (inputPath.toLowerCase().endsWith('.zip')) {
    throw new Error('unzip the export first, then pick the folder or conversations.json');
  }
  return inputPath;
}

/** Import an export the user picked. Never throws; failures come back as errors. */
export async function importClaudeAiExport(
  inputPath: string,
  options: ImportOptions = {},
): Promise<ClaudeAiImport> {
  const importedAt = (options.now ?? Date.now)();
  let sourcePath: string | null = null;
  try {
    sourcePath = await resolveExportFile(inputPath);
    const json: unknown = JSON.parse(await readFile(sourcePath, 'utf8'));
    const parsed = parseClaudeAiExport(json);
    return { ...parsed, importedAt, sourcePath };
  } catch (error) {
    return {
      conversations: [],
      errors: [sourceError(SOURCE, error, sourcePath ?? inputPath)],
      importedAt,
      sourcePath,
    };
  }
}
