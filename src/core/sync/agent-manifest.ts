// agents/<id>/overlord.json: what the config repo keeps for one agent past
// Claude Code. It lives next to that agent's files so an Overlord that only
// knows the top level overlord.json never reads or rewrites it.

import { z } from 'zod';

import type { AgentId } from '../../shared/agents.js';

import { readTextOrNull } from './files.js';
import { compareStrings, parseJson, stableJson } from './json.js';
import { agentManifestPath, agentRepoDir, repoFile } from './layout.js';
import { isSafeRepoPath, kindSchema } from './manifest.js';

const AGENT_MANIFEST_VERSION = 1;

const repoPath = z
  .string()
  .refine(isSafeRepoPath, { error: 'must be a relative path in the repo' });

const agentItemSchema = z.object({
  id: z.string().min(1),
  kind: kindSchema,
  /** Path in the repo, under agents/<id>/. */
  source: repoPath,
  /** Path inside the agent's folder, so $CODEX_HOME or $COPILOT_HOME moves it along. */
  target: repoPath,
  mode: z.enum(['link', 'copy']),
});

const agentManifestSchema = z.object({
  version: z.literal(AGENT_MANIFEST_VERSION),
  items: z.array(agentItemSchema).default([]),
  /** The synced settings keys as JSON, applied one key at a time. */
  settings: repoPath.nullable().default(null),
  /** User MCP servers, shaped like .mcp.json, with secrets as placeholders. */
  mcp: repoPath.nullable().default(null),
});

export type AgentManifest = z.output<typeof agentManifestSchema>;
export type AgentManifestItem = z.output<typeof agentItemSchema>;

export type AgentManifestResult =
  | { readonly ok: true; readonly manifest: AgentManifest }
  /** Missing is true when the repo has nothing for the agent, which is not an error. */
  | { readonly ok: false; readonly missing: boolean; readonly error: string };

export function emptyAgentManifest(): AgentManifest {
  return agentManifestSchema.parse({ version: AGENT_MANIFEST_VERSION });
}

function insideAgentDir(agent: AgentId, manifest: AgentManifest): string | null {
  const prefix = `${agentRepoDir(agent)}/`;
  const sources = [
    ...manifest.items.map((item) => item.source),
    ...(manifest.settings === null ? [] : [manifest.settings]),
    ...(manifest.mcp === null ? [] : [manifest.mcp]),
  ];
  return sources.find((source) => !source.startsWith(prefix)) ?? null;
}

export function parseAgentManifest(agent: AgentId, value: unknown): AgentManifestResult {
  const result = agentManifestSchema.safeParse(value);
  if (!result.success) {
    return { ok: false, missing: false, error: z.prettifyError(result.error) };
  }
  const outside = insideAgentDir(agent, result.data);
  return outside === null
    ? { ok: true, manifest: result.data }
    : { ok: false, missing: false, error: `${outside} is outside ${agentRepoDir(agent)}/` };
}

export async function readAgentManifest(
  repoRoot: string,
  agent: AgentId,
): Promise<AgentManifestResult> {
  const relative = agentManifestPath(agent);
  const text = await readTextOrNull(repoFile(repoRoot, relative));
  if (text === null) {
    return { ok: false, missing: true, error: `${relative} not found` };
  }
  const value = parseJson(text);
  if (value === undefined) {
    return { ok: false, missing: false, error: `${relative} is not valid JSON` };
  }
  return parseAgentManifest(agent, value);
}

/** The manifest the repo has for the agent, or an empty one. */
export async function agentManifestOrEmpty(
  repoRoot: string,
  agent: AgentId,
): Promise<AgentManifest> {
  const read = await readAgentManifest(repoRoot, agent);
  return read.ok ? read.manifest : emptyAgentManifest();
}

export function serializeAgentManifest(manifest: AgentManifest): string {
  return stableJson({
    ...manifest,
    items: [...manifest.items].toSorted((a, b) => compareStrings(a.id, b.id)),
  });
}

/** Add items, replacing any with the same id. */
export function upsertAgentItems(
  manifest: AgentManifest,
  items: readonly AgentManifestItem[],
): AgentManifest {
  const ids = new Set(items.map((item) => item.id));
  return { ...manifest, items: [...manifest.items.filter((item) => !ids.has(item.id)), ...items] };
}
