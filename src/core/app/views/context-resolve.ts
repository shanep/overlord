// Runs the "why or why not loaded" resolver for one session and folds the
// answer into its context snapshot. An agent whose transcript names no MCP
// servers (Copilot, Codex) gets the ones its MCP store lists for the folder.

import path from 'node:path';

import type { ContextSnapshot, LoadedInstruction, SessionSummary } from '../../../shared/model.js';
import { claudeKnobs } from '../../agents/claude/config.js';
import { agents } from '../../agents/index.js';
import type { FileSystem } from '../../context/fs.js';
import { resolveContext } from '../../context/resolve.js';
import { discoverSkills } from '../../context/skills.js';
import { mergeIntoSnapshot } from '../../context/snapshot.js';
import type { ContextFlags } from '../../context/types.js';
import { catalogEnvKeys, loadCatalog } from '../../knobs/catalog.js';
import { computeEffective } from '../../knobs/effective.js';
import { isPlainObject } from '../../knobs/json.js';
import { loadLayers } from '../../knobs/layers.js';
import type { ClaudePaths } from '../../paths.js';
import type { OverlordStore } from '../../store/store.js';
import type { Exec } from '../../sync/exec.js';
import { repoRootOf } from '../../sync/git.js';
import { contextSettings } from '../settings-view.js';

export interface ResolveDeps {
  readonly paths: ClaudePaths;
  readonly fs: FileSystem;
  readonly exec: Exec;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly store: OverlordStore;
  readonly clock: () => number;
}

export interface ResolveJob {
  readonly base: ContextSnapshot;
  readonly session: SessionSummary;
  readonly agentId: string;
  /** Loads the InstructionsLoaded hook reported, on top of the transcript's. */
  readonly observed: readonly LoadedInstruction[];
}

// Observed sessions do not tell us their CLI flags, so assume none were passed.
const NO_FLAGS: ContextFlags = { bare: false, safeMode: false, settingSources: null, addDirs: [] };

const PATH_KEYS: readonly string[] = ['file_path', 'path'];

/** The file a tool call read or wrote, from its input. */
export function pathInput(input: unknown): string | null {
  if (!isPlainObject(input)) {
    return null;
  }
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return null;
}

/** Absolute paths every agent in the session touched with a file tool. */
export function touchedFiles(
  store: OverlordStore,
  session: Pick<SessionSummary, 'id' | 'cwd'>,
  now: number,
): string[] {
  const agentIds = new Set([
    session.id,
    ...store
      .fleetState(now)
      .agents.filter((agent) => agent.sessionId === session.id)
      .map((agent) => agent.id),
  ]);
  const files = new Set<string>();
  for (const agentId of agentIds) {
    for (const call of store.agentDetailState(session.id, agentId).toolCalls) {
      const target = pathInput(call.input);
      if (target !== null) {
        files.add(path.resolve(session.cwd, target));
      }
    }
  }
  return [...files];
}

/** The first list, plus entries of the second whose path it does not have yet. */
export function mergeLoaded(
  first: readonly LoadedInstruction[],
  second: readonly LoadedInstruction[],
): LoadedInstruction[] {
  const seen = new Set(first.map((item) => item.path));
  return [...first, ...second.filter((item) => !seen.has(item.path))];
}

/**
 * The servers the agent's MCP store has turned on for the folder, with no
 * instructions, for an agent whose transcript does not list them. An agent
 * with the full context capture (Claude Code) lists the servers it loaded, so
 * an empty list there means none, not unknown.
 */
async function storeServers(
  deps: Pick<ResolveDeps, 'paths' | 'env'>,
  session: Pick<SessionSummary, 'agent' | 'cwd'>,
): Promise<ContextSnapshot['mcpServers']> {
  const adapter = agents.get(session.agent);
  const store = adapter?.config?.mcp;
  if (store === undefined || adapter?.capabilities.contextInspector === true) {
    return [];
  }
  const place = { home: deps.paths.home, env: deps.env, claude: deps.paths, cwd: session.cwd };
  const found = await store.read(place);
  const names = new Set(
    found.servers.filter((server) => server.state !== 'off').map((server) => server.name),
  );
  return [...names].map((name) => ({ name, instructions: '' }));
}

export async function resolveSnapshot(
  deps: ResolveDeps,
  job: ResolveJob,
): Promise<ContextSnapshot> {
  const { cwd } = job.session;
  const gitRoot = await repoRootOf(deps.exec, cwd);
  const layers = await loadLayers({
    knobs: claudeKnobs,
    paths: deps.paths,
    projectDir: cwd,
    env: deps.env,
    envKeys: catalogEnvKeys(loadCatalog()),
  });
  const settings = contextSettings(layers, computeEffective(layers, claudeKnobs), deps.env);
  const touched = touchedFiles(deps.store, job.session, deps.clock());
  const observedLoaded = mergeLoaded(job.base.loaded, job.observed);
  const resolved = await resolveContext({
    agentId: job.session.agent,
    fs: deps.fs,
    paths: deps.paths,
    cwd,
    gitRoot,
    settings,
    flags: NO_FLAGS,
    agent: { isSubagent: job.agentId !== job.session.id, omitClaudeMd: false },
    touchedFiles: touched,
    observedLoaded,
    approvedExternalImports: false,
  });
  const skills = await discoverSkills({
    agentId: job.session.agent,
    fs: deps.fs,
    paths: deps.paths,
    cwd,
    gitRoot,
    addDirs: [],
    touchedFiles: touched,
    plugins: [],
    bare: false,
    safeMode: false,
    env: settings.env,
    invoked: job.base.skills.filter((skill) => skill.invoked).map((skill) => skill.name),
  });
  const mcpServers =
    job.base.mcpServers.length > 0 ? job.base.mcpServers : await storeServers(deps, job.session);
  return mergeIntoSnapshot({ ...job.base, loaded: observedLoaded, mcpServers }, resolved, skills);
}
