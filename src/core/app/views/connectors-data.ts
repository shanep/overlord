// What the connectors cache holds, and the loader behind it. It takes its
// inputs one by one rather than the runtime, which holds this cache.

import type { AgentId } from '../../../shared/agents.js';
import { CLAUDE_CODE } from '../../../shared/agents.js';
import type { ConnectorsState } from '../../../shared/connectors.js';
import type { AgentRegistry } from '../../agents/registry.js';
import type { AgentCli, McpPlace, ShellEnv } from '../../agents/types.js';
import type { McpSource } from '../../connectors/check.js';
import { checkConnectors } from '../../connectors/check.js';
import type { StdioToolCaller } from '../../connectors/stdio-mcp.js';
import { mergeEnv } from '../../harness/options.js';
import type { ClaudePaths } from '../../paths.js';
import type { Exec } from '../../sync/exec.js';

export type ConnectorsData = Omit<ConnectorsState, 'checking' | 'registry'>;

export const EMPTY_CONNECTORS: ConnectorsData = {
  connectors: [],
  checkedAt: null,
  folder: null,
  mcpAgents: [CLAUDE_CODE],
};

export interface ConnectorsLoad {
  readonly claudeCli: () => Promise<AgentCli>;
  /** The login shell's environment, for finding the other agents and their folders. */
  readonly loginEnv: () => Promise<ShellEnv>;
  readonly registry: AgentRegistry;
  /** The binary the user set for an agent, or "" for its default name. */
  readonly agentPath: (id: AgentId) => string;
  /** False when overlord.agents turns the agent off. */
  readonly agentEnabled: (id: AgentId) => boolean;
  /** Where `claude mcp list` runs, or null for the home folder. */
  readonly workspace: string | null;
  readonly paths: ClaudePaths;
  readonly platform: NodeJS.Platform;
  readonly exec: Exec;
  readonly callTool: StdioToolCaller;
  readonly clock: () => number;
}

/** Every installed agent past Claude Code that has an MCP store, in registry order. */
async function otherSources(load: ConnectorsLoad, env: ShellEnv): Promise<McpSource[]> {
  const found = await Promise.all(
    load.registry.list().map(async (adapter): Promise<McpSource | null> => {
      const store = adapter.config?.mcp;
      if (adapter.id === CLAUDE_CODE || store === undefined || !load.agentEnabled(adapter.id)) {
        return null;
      }
      const detected = await adapter.detect({
        env,
        platform: load.platform,
        path: load.agentPath(adapter.id),
      });
      return detected.bin === null
        ? null
        : { agent: adapter.id, store, cli: { bin: detected.bin, env: mergeEnv(env, {}) } };
    }),
  );
  return found.filter((source): source is McpSource => source !== null);
}

export async function loadConnectors(load: ConnectorsLoad): Promise<ConnectorsData> {
  const [cli, env] = await Promise.all([load.claudeCli(), load.loginEnv()]);
  const cwd = load.workspace ?? load.paths.home;
  const claudeStore = load.registry.get(CLAUDE_CODE)?.config?.mcp;
  const claude: McpSource[] =
    claudeStore === undefined ? [] : [{ agent: CLAUDE_CODE, store: claudeStore, cli }];
  const others = await otherSources(load, env);
  const place: McpPlace = { home: load.paths.home, env, claude: load.paths, cwd };
  const connectors = await checkConnectors({
    claude: cli,
    mcp: [...claude, ...others],
    place,
    cwd,
    home: load.paths.home,
    claudeJson: load.paths.claudeJson,
    platform: load.platform,
    exec: load.exec,
    callTool: load.callTool,
  });
  return {
    connectors,
    checkedAt: load.clock(),
    folder: load.workspace,
    mcpAgents: [CLAUDE_CODE, ...others.map((source) => source.agent)],
  };
}
