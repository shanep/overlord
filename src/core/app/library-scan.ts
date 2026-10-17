// Which agents' skill and agent folders count, and the scan of the folders
// only agents past Claude Code read, for the Skills and Agents views and for
// saving a new skill or agent.

import { CLAUDE_CODE } from '../../shared/agents.js';
import { agents } from '../agents/index.js';
import type { AgentRegistry } from '../agents/registry.js';
import { detectAgents } from '../agents/registry.js';
import type { LibraryPlace } from '../agents/types.js';
import type { LibraryReader, LibraryScan } from '../authoring/library.js';
import { libraryReaders, scanLibrary } from '../authoring/library.js';
import { repoRootOf } from '../sync/git.js';

import { agentEnabled, agentPath } from './claude-bin.js';
import type { Runtime } from './runtime.js';

type ScanRuntime = Pick<
  Runtime,
  'loginEnv' | 'platform' | 'host' | 'paths' | 'env' | 'exec' | 'fs'
>;

/** The agents in play, found the way the agents cache finds them. */
export async function readersInPlay(
  rt: ScanRuntime,
  registry: AgentRegistry = agents,
): Promise<LibraryReader[]> {
  const env = await rt.loginEnv();
  const found = await detectAgents(registry, {
    env,
    platform: rt.platform,
    pathFor: (id) => agentPath(rt.host.settings, id),
  });
  const usable = new Set(
    found
      .filter((info) => info.installed && agentEnabled(rt.host.settings, info.id))
      .map((info) => info.id),
  );
  return libraryReaders(registry.list(), (id) => usable.has(id));
}

/** The place to read folders for, in cwd. A null git root keeps project folders to cwd itself. */
export function libraryPlace(
  rt: Pick<Runtime, 'paths' | 'env'>,
  cwd: string | null,
  gitRoot: string | null,
): LibraryPlace {
  return { home: rt.paths.home, env: rt.env, claude: rt.paths, cwd, gitRoot, plugins: [] };
}

export function emptyLibrary(rt: Pick<Runtime, 'paths' | 'env'>): LibraryScan {
  return { readers: [], place: libraryPlace(rt, null, null), skill: [], agent: [] };
}

/** What the other agents' folders hold for the workspace. Only Claude Code in play reads nothing. */
export async function loadLibrary(
  rt: ScanRuntime,
  registry: AgentRegistry = agents,
): Promise<LibraryScan> {
  const readers = await readersInPlay(rt, registry);
  const scan = readers.filter((reader) => reader.id !== CLAUDE_CODE);
  const workspace = rt.host.workspaceFolder();
  if (scan.length === 0) {
    return { ...emptyLibrary(rt), readers };
  }
  const gitRoot = workspace === null ? null : await repoRootOf(rt.exec, workspace);
  const place = libraryPlace(rt, workspace, gitRoot);
  const common = { fs: rt.fs, place, readers, scan };
  return {
    readers,
    place,
    skill: await scanLibrary({ ...common, kind: 'skill' }),
    agent: await scanLibrary({ ...common, kind: 'agent' }),
  };
}
