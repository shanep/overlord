// Every agent's hooks and telemetry, for the hook server, the OTLP receiver
// and the setup commands: where each agent keeps its files, which agents past
// Claude Code have Overlord's hooks or export on, the dialect the server
// reads a relay's --agent value with, and the decoder for each export.

import type { AgentId } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentAdapter, AgentDirs, ShellEnv } from '../agents/types.js';
import type { HookDialect } from '../hooks/normalized.js';
import type { ConfigOverride } from '../knobs/facet.js';
import { decodeByService } from '../otel/by-service.js';
import type { TelemetryDecode } from '../otel/decode.js';
import { decode as claudeDecode } from '../otel/decode.js';
import type { ClaudePaths } from '../paths.js';

/** The agent's own folder, from its instruction policy, or null when it names none. */
export function agentDirs(
  adapter: AgentAdapter,
  paths: ClaudePaths,
  env: ShellEnv,
): AgentDirs | null {
  if (adapter.id === CLAUDE_CODE) {
    return { home: paths.home, configDir: paths.configDir };
  }
  const configDir = adapter.instructions?.configDir({ home: paths.home, env, claude: paths });
  return configDir === undefined ? null : { home: paths.home, configDir };
}

/** Agents past Claude Code for which check says yes. A check that throws counts as no. */
async function othersWhere(
  registry: AgentRegistry,
  paths: ClaudePaths,
  env: ShellEnv,
  check: (adapter: AgentAdapter, dirs: AgentDirs) => Promise<boolean>,
): Promise<readonly AgentAdapter[]> {
  const found = await Promise.all(
    registry.list().map(async (adapter) => {
      const dirs = agentDirs(adapter, paths, env);
      if (adapter.id === CLAUDE_CODE || dirs === null) {
        return null;
      }
      const yes = await check(adapter, dirs).catch(() => false);
      return yes ? adapter : null;
    }),
  );
  return found.filter((adapter): adapter is AgentAdapter => adapter !== null);
}

/** Agents past Claude Code whose files hold Overlord's hooks. */
export async function hookedAgents(
  registry: AgentRegistry,
  paths: ClaudePaths,
  env: ShellEnv,
): Promise<readonly AgentAdapter[]> {
  return othersWhere(
    registry,
    paths,
    env,
    async (adapter, dirs) => (await adapter.hooks?.installed(dirs)) ?? false,
  );
}

/** Agents past Claude Code whose own settings export to Overlord's receiver. */
export async function exportingAgents(
  registry: AgentRegistry,
  paths: ClaudePaths,
  env: ShellEnv,
): Promise<readonly AgentAdapter[]> {
  return othersWhere(
    registry,
    paths,
    env,
    async (adapter, dirs) => (await adapter.telemetry?.enabled?.(dirs)) ?? false,
  );
}

/** The dialect for a relay's --agent value: that agent's hooks facet, or null when it has none. */
export function dialectsOf(registry: AgentRegistry): (agent: AgentId) => HookDialect | null {
  return (agent) => registry.get(agent)?.hooks ?? null;
}

/** Each export goes to the agent whose service.name it carries, and anything else to Claude Code's decoder. */
export function telemetryDecoder(registry: AgentRegistry): TelemetryDecode {
  return decodeByService(
    (name) =>
      registry.list().find((adapter) => adapter.telemetry?.sends?.(name) === true)?.telemetry
        ?.decode ?? null,
    claudeDecode,
  );
}

export interface TelemetryLaunch {
  readonly registry: AgentRegistry;
  readonly paths: ClaudePaths;
  readonly env: ShellEnv;
  /** The receiver's port, or null when it is not running. */
  readonly port: number | null;
}

/** Overrides that send one launch's export to the receiver, when it runs and the agent takes them. */
export async function telemetryConfig(
  launch: TelemetryLaunch,
  agent: AgentId,
): Promise<readonly ConfigOverride[]> {
  const adapter = launch.registry.get(agent);
  const make = adapter?.telemetry?.launchConfig;
  const dirs = adapter === null ? null : agentDirs(adapter, launch.paths, launch.env);
  if (make === undefined || dirs === null || launch.port === null) {
    return [];
  }
  return make(dirs, launch.port).catch(() => []);
}
