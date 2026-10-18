// Which local Claude Code processes are running right now. Two sources:
// ~/.claude/sessions/<pid>.json (undocumented, can be stale when the pid is
// dead) and `claude agents --json` (documented). Tested against 2.1.301.

import path from 'node:path';

import { z } from 'zod';

import type { AgentId } from '../../shared/agents.js';
import type { ClaudePaths } from '../paths.js';

import { readDirOrEmpty, readJsonFile, sourceError } from './common.js';
import type { Collected, SourceError } from './common.js';
import type { ExecFunction, IsAlive } from './process.js';

const registrySchema = z.object({
  pid: z.number().int(),
  sessionId: z.string().min(1),
  cwd: z.string().nullish(),
  kind: z.string().nullish(),
  entrypoint: z.string().nullish(),
  status: z.string().nullish(),
  statusUpdatedAt: z.number().nullish(),
  startedAt: z.number().nullish(),
  updatedAt: z.number().nullish(),
  name: z.string().nullish(),
  jobId: z.string().nullish(),
  version: z.string().nullish(),
  messagingSocketPath: z.string().nullish(),
});

const agentSchema = z.object({
  id: z.string().nullish(),
  pid: z.number().int().nullish(),
  sessionId: z.string().min(1),
  cwd: z.string().nullish(),
  kind: z.string().nullish(),
  name: z.string().nullish(),
  state: z.string().nullish(),
  status: z.string().nullish(),
  startedAt: z.number().nullish(),
});

export interface RegistryEntry {
  readonly pid: number;
  readonly sessionId: string;
  /** The CLI that registered this process. */
  readonly agent?: AgentId;
  readonly cwd: string | null;
  readonly kind: string | null;
  readonly entrypoint: string | null;
  readonly status: string | null;
  readonly statusUpdatedAt: number | null;
  readonly startedAt: number | null;
  readonly updatedAt: number | null;
  readonly name: string | null;
  readonly version: string | null;
  readonly messagingSocketPath: string | null;
}

export interface AgentEntry {
  readonly id: string | null;
  readonly pid: number | null;
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly kind: string | null;
  readonly name: string | null;
  readonly state: string | null;
  readonly status: string | null;
  readonly startedAt: number | null;
}

type LiveSource = 'registry' | 'agents';

export interface LiveProcess {
  readonly sessionId: string;
  readonly pid: number | null;
  readonly alive: boolean;
  /** Background agent state from `claude agents`, for example "working" or "stopped". */
  readonly state: string | null;
  /** "busy" or "idle" as Claude Code reports it. */
  readonly status: string | null;
  /** "interactive" or "background" ("bg" in the registry is normalized). */
  readonly kind: string | null;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly entrypoint: string | null;
  readonly version: string | null;
  readonly startedAt: number | null;
  readonly updatedAt: number | null;
  /** Background agent id from `claude agents`. */
  readonly agentId: string | null;
  readonly messagingSocketPath: string | null;
  readonly sources: readonly LiveSource[];
}

export interface LiveProcessTable {
  readonly processes: ReadonlyMap<string, LiveProcess>;
  readonly errors: readonly SourceError[];
}

export interface LiveDeps {
  readonly paths: ClaudePaths;
  readonly exec: ExecFunction;
  readonly isAlive: IsAlive;
  readonly options?: AgentsOptions | undefined;
}

export interface AgentsOptions {
  /** Defaults to "claude" on PATH. */
  readonly claudeBin?: string;
  readonly timeoutMs?: number;
  /** Pass --all to include completed background sessions. */
  readonly includeCompleted?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;

function normalizeKind(kind: string | null): string | null {
  return kind === 'bg' ? 'background' : kind;
}

/**
 * Claude Code names a background session after its job id until the first
 * prompt gives it a real name, so that placeholder counts as no name.
 */
function realName(
  name: string | null | undefined,
  jobId: string | null | undefined,
): string | null {
  return name === jobId ? null : (name ?? null);
}

function toRegistryEntry(raw: z.infer<typeof registrySchema>): RegistryEntry {
  return {
    pid: raw.pid,
    sessionId: raw.sessionId,
    cwd: raw.cwd ?? null,
    kind: normalizeKind(raw.kind ?? null),
    entrypoint: raw.entrypoint ?? null,
    status: raw.status ?? null,
    statusUpdatedAt: raw.statusUpdatedAt ?? null,
    startedAt: raw.startedAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    name: realName(raw.name, raw.jobId),
    version: raw.version ?? null,
    messagingSocketPath: raw.messagingSocketPath ?? null,
  };
}

function toAgentEntry(raw: z.infer<typeof agentSchema>): AgentEntry {
  return {
    id: raw.id ?? null,
    pid: raw.pid ?? null,
    sessionId: raw.sessionId,
    cwd: raw.cwd ?? null,
    kind: normalizeKind(raw.kind ?? null),
    name: realName(raw.name, raw.id),
    state: raw.state ?? null,
    status: raw.status ?? null,
    startedAt: raw.startedAt ?? null,
  };
}

/** Read every ~/.claude/sessions/<pid>.json. Bad files become errors, not exceptions. */
export async function readSessionRegistry(paths: ClaudePaths): Promise<Collected<RegistryEntry>> {
  const entries = await readDirOrEmpty(paths.sessionsDir);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(paths.sessionsDir, entry.name));
  const results = await Promise.all(
    files.map(async (file): Promise<RegistryEntry | SourceError> => {
      try {
        return toRegistryEntry(await readJsonFile(file, registrySchema));
      } catch (error) {
        return sourceError('session-registry', error, file);
      }
    }),
  );
  const items: RegistryEntry[] = [];
  const errors: SourceError[] = [];
  for (const result of results) {
    if ('pid' in result) {
      items.push(result);
    } else {
      errors.push(result);
    }
  }
  return { items: items.toSorted((a, b) => a.pid - b.pid), errors };
}

/** Parse `claude agents --json` output. Entries that do not fit are reported and skipped. */
export function parseAgentsJson(stdout: string): Collected<AgentEntry> {
  const parsed = z.array(z.unknown()).safeParse(JSON.parse(stdout));
  if (!parsed.success) {
    throw new Error('expected a JSON array');
  }
  const items: AgentEntry[] = [];
  const errors: SourceError[] = [];
  for (const [index, raw] of parsed.data.entries()) {
    const entry = agentSchema.safeParse(raw);
    if (entry.success) {
      items.push(toAgentEntry(entry.data));
    } else {
      errors.push({
        source: 'claude-agents',
        message: `entry ${String(index)} skipped`,
        path: null,
      });
    }
  }
  return { items, errors };
}

/** Run `claude agents --json` through the injected exec. Never throws. */
export async function readClaudeAgents(
  exec: ExecFunction,
  options: AgentsOptions = {},
): Promise<Collected<AgentEntry>> {
  const args =
    options.includeCompleted === true ? ['agents', '--json', '--all'] : ['agents', '--json'];
  try {
    const { stdout } = await exec(options.claudeBin ?? 'claude', args, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return parseAgentsJson(stdout);
  } catch (error) {
    return { items: [], errors: [sourceError('claude-agents', error, null)] };
  }
}

function newer(a: RegistryEntry, b: RegistryEntry): RegistryEntry {
  return (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a;
}

// Several registry files can name one session (a resume under a new pid
// while the old file lingers). The live one wins, then the newest.
export function pickRegistry(
  entries: readonly RegistryEntry[],
  isAlive: IsAlive,
): Map<string, RegistryEntry> {
  const picked = new Map<string, RegistryEntry>();
  for (const entry of entries) {
    const current = picked.get(entry.sessionId);
    if (current === undefined) {
      picked.set(entry.sessionId, entry);
      continue;
    }
    const currentAlive = isAlive(current.pid);
    if (currentAlive === isAlive(entry.pid)) {
      picked.set(entry.sessionId, newer(current, entry));
    } else {
      picked.set(entry.sessionId, currentAlive ? current : entry);
    }
  }
  return picked;
}

// The registry-only fields for a session that `claude agents` alone reported.
const EMPTY_LIVE: LiveProcess = {
  sessionId: '',
  pid: null,
  alive: false,
  state: null,
  status: null,
  kind: null,
  name: null,
  cwd: null,
  entrypoint: null,
  version: null,
  startedAt: null,
  updatedAt: null,
  agentId: null,
  messagingSocketPath: null,
  sources: [],
};

function fromRegistry(entry: RegistryEntry, isAlive: IsAlive): LiveProcess {
  return {
    sessionId: entry.sessionId,
    pid: entry.pid,
    alive: isAlive(entry.pid),
    state: null,
    status: entry.status,
    kind: entry.kind,
    name: entry.name,
    cwd: entry.cwd,
    entrypoint: entry.entrypoint,
    version: entry.version,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    agentId: null,
    messagingSocketPath: entry.messagingSocketPath,
    sources: ['registry'],
  };
}

function or<T>(first: T | null, second: T | null): T | null {
  return first ?? second;
}

function withAgent(
  base: LiveProcess | undefined,
  agent: AgentEntry,
  isAlive: IsAlive,
): LiveProcess {
  const prior = base ?? EMPTY_LIVE;
  const pid = or(agent.pid, prior.pid);
  return {
    ...prior,
    sessionId: agent.sessionId,
    pid,
    alive: pid !== null && isAlive(pid),
    state: agent.state,
    status: or(agent.status, prior.status),
    kind: or(agent.kind, prior.kind),
    name: or(agent.name, prior.name),
    cwd: or(agent.cwd, prior.cwd),
    startedAt: or(agent.startedAt, prior.startedAt),
    agentId: agent.id,
    sources: base === undefined ? ['agents'] : ['registry', 'agents'],
  };
}

/** Merge registry and `claude agents` rows into one row per session id. */
export function mergeLiveProcesses(
  registry: readonly RegistryEntry[],
  agents: readonly AgentEntry[],
  isAlive: IsAlive,
): Map<string, LiveProcess> {
  const table = new Map<string, LiveProcess>();
  for (const entry of pickRegistry(registry, isAlive).values()) {
    table.set(entry.sessionId, fromRegistry(entry, isAlive));
  }
  for (const agent of agents) {
    table.set(agent.sessionId, withAgent(table.get(agent.sessionId), agent, isAlive));
  }
  return table;
}

/** Build the table from both sources. A failure in one still returns the other. */
export async function buildLiveProcessTable(deps: LiveDeps): Promise<LiveProcessTable> {
  const [registry, agents] = await Promise.all([
    readSessionRegistry(deps.paths).catch((error: unknown): Collected<RegistryEntry> => ({
      items: [],
      errors: [sourceError('session-registry', error, deps.paths.sessionsDir)],
    })),
    readClaudeAgents(deps.exec, deps.options),
  ]);
  return {
    processes: mergeLiveProcesses(registry.items, agents.items, deps.isAlive),
    errors: [...registry.errors, ...agents.errors],
  };
}
