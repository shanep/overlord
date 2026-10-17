// Subagent transcripts live next to the main one, in
// <session-id>/subagents/agent-<id>.jsonl with an agent-<id>.meta.json beside
// it (workflow agents sit one or two folders deeper). The meta file names the
// tool use that spawned the agent, which links it to its parent.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { AgentNode, SessionState, TokenUsage } from '../../shared/model.js';

const looseString = z.string().nullish().catch(null);

const subagentMetaSchema = z.object({
  agentType: z.string().catch('unknown'),
  description: z.string().catch(''),
  toolUseId: looseString,
  parentAgentId: looseString,
  spawnDepth: z.number().int().nonnegative().catch(1),
  requestShape: looseString,
  model: looseString,
});

export type SubagentMeta = z.infer<typeof subagentMetaSchema>;

export interface SubagentFile {
  readonly agentId: string;
  readonly transcriptPath: string;
  readonly metaPath: string;
}

const AGENT_FILE = /^agent-(.+)\.jsonl$/u;

/** The agent id in an "agent-<id>.jsonl" file name, or null for other files. */
export function agentIdFromFileName(name: string): string | null {
  return AGENT_FILE.exec(name)?.[1] ?? null;
}

export function parseSubagentMeta(text: string): SubagentMeta | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const result = subagentMetaSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Read a meta file. A missing or broken file gives null, since it may not be written yet. */
export async function readSubagentMeta(metaPath: string): Promise<SubagentMeta | null> {
  try {
    return parseSubagentMeta(await readFile(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Every subagent transcript under <sessionDir>/subagents, at any depth. */
export async function listSubagentFiles(sessionDir: string): Promise<SubagentFile[]> {
  const root = path.join(sessionDir, 'subagents');
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    return [];
  }
  const files: SubagentFile[] = [];
  for (const entry of entries.toSorted((left, right) => left.localeCompare(right))) {
    const agentId = agentIdFromFileName(path.basename(entry));
    if (agentId !== null) {
      const transcriptPath = path.join(root, entry);
      files.push({
        agentId,
        transcriptPath,
        metaPath: transcriptPath.replace(/\.jsonl$/u, '.meta.json'),
      });
    }
  }
  return files;
}

/** What the session knows about tool uses, across every thread. */
export interface SpawnLookup {
  /** The agent whose transcript holds this tool use, if any thread has it yet. */
  ownerOf: (toolUseId: string) => string | null;
  resultOf: (toolUseId: string) => {
    readonly at: number;
    readonly ok: boolean;
    readonly async: boolean;
    readonly error?: string | null;
  } | null;
  notificationOf: (toolUseId: string) => {
    readonly at: number;
    readonly status: string;
    readonly summary?: string | null;
  } | null;
}

export interface Completion {
  readonly state: SessionState;
  readonly endedAt: number;
  /** Why it failed, from the task notification or the tool result, when either says. */
  readonly failure: string | null;
}

const FAILED_STATUSES = new Set(['failed', 'error']);

/**
 * A foreground agent ends when its parent gets the tool result. A background
 * agent's tool result only says it launched, so it ends at its task notification.
 */
export function spawnCompletion(toolUseId: string, lookup: SpawnLookup): Completion | null {
  const notification = lookup.notificationOf(toolUseId);
  if (notification !== null) {
    const failed = FAILED_STATUSES.has(notification.status);
    return {
      state: failed ? 'failed' : 'done',
      endedAt: notification.at,
      failure: failed ? (notification.summary ?? null) : null,
    };
  }
  const result = lookup.resultOf(toolUseId);
  if (result === null || result.async) {
    return null;
  }
  return {
    state: result.ok ? 'done' : 'failed',
    endedAt: result.at,
    failure: result.ok ? null : (result.error ?? null),
  };
}

/** Everything about one subagent thread that is not in the meta file. */
export interface SubagentActivity {
  readonly agentId: string;
  readonly sessionId: string;
  readonly transcriptPath: string | null;
  readonly startedAt: number;
  readonly liveState: SessionState;
  readonly usage: TokenUsage;
  readonly toolCallCount: number;
  readonly currentTool: string | null;
  readonly model: string | null;
}

interface MetaFields {
  readonly parentToolUseId: string | null;
  readonly agentType: string;
  readonly description: string;
  readonly spawnDepth: number;
  readonly background: boolean;
  readonly model: string | null;
}

function metaFields(meta: SubagentMeta | null): MetaFields {
  if (meta === null) {
    return {
      parentToolUseId: null,
      agentType: 'unknown',
      description: '',
      spawnDepth: 1,
      background: false,
      model: null,
    };
  }
  return {
    parentToolUseId: meta.toolUseId ?? null,
    agentType: meta.agentType,
    description: meta.description,
    spawnDepth: meta.spawnDepth,
    background: meta.requestShape === 'background',
    model: meta.model ?? null,
  };
}

/**
 * The parent is whichever thread holds the spawning tool use. Until that
 * thread has been read we fall back to the meta file, then the main thread.
 */
function parentOf(meta: SubagentMeta | null, sessionId: string, lookup: SpawnLookup): string {
  const toolUseId = meta?.toolUseId ?? null;
  const owner = toolUseId === null ? null : lookup.ownerOf(toolUseId);
  return owner ?? meta?.parentAgentId ?? sessionId;
}

export function buildSubagentNode(
  activity: SubagentActivity,
  meta: SubagentMeta | null,
  lookup: SpawnLookup,
): AgentNode {
  const fields = metaFields(meta);
  const toolUseId = fields.parentToolUseId;
  const completion = toolUseId === null ? null : spawnCompletion(toolUseId, lookup);
  const failure = completion?.failure ?? null;
  return {
    id: activity.agentId,
    sessionId: activity.sessionId,
    parentAgentId: parentOf(meta, activity.sessionId, lookup),
    parentToolUseId: toolUseId,
    agentType: fields.agentType,
    description: fields.description,
    spawnDepth: fields.spawnDepth,
    background: fields.background,
    state: completion?.state ?? activity.liveState,
    startedAt: activity.startedAt,
    endedAt: completion?.endedAt ?? null,
    transcriptPath: activity.transcriptPath,
    usage: activity.usage,
    toolCallCount: activity.toolCallCount,
    currentTool: completion === null ? activity.currentTool : null,
    model: activity.model ?? fields.model,
    ...(failure === null ? {} : { failure }),
  };
}
