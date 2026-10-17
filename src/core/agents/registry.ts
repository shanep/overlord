// The agent adapters Overlord knows, looked up by id, and what the webview is
// told about each one.

import type { AgentId, AgentInfo } from '../../shared/agents.js';

import type { AgentAdapter, Detected, ShellEnv } from './types.js';

export class AgentRegistry {
  private readonly byId: ReadonlyMap<AgentId, AgentAdapter>;

  constructor(adapters: readonly AgentAdapter[]) {
    this.byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  /** The adapter for an id, or null when no adapter has it. */
  get(id: AgentId): AgentAdapter | null {
    return this.byId.get(id) ?? null;
  }

  /** Every adapter, in the order they were registered. */
  list(): readonly AgentAdapter[] {
    return [...this.byId.values()];
  }
}

const NOT_DETECTED: Detected = { bin: null, version: null };

export function agentInfo(adapter: AgentAdapter, detected: Detected = NOT_DETECTED): AgentInfo {
  return {
    id: adapter.id,
    name: adapter.name,
    short: adapter.short,
    icon: adapter.icon,
    installed: detected.bin !== null,
    version: detected.version,
    capabilities: adapter.capabilities,
    permissionModes: adapter.modes.permission,
    effortLevels: adapter.modes.effort,
  };
}

interface DetectAllInput {
  readonly env: ShellEnv;
  readonly platform: NodeJS.Platform;
  /** The binary the user set for an agent, or "" for its default name. */
  readonly pathFor: (id: AgentId) => string;
}

/** Looks for every agent's binary and describes each one for the webview. */
export async function detectAgents(
  registry: AgentRegistry,
  input: DetectAllInput,
): Promise<AgentInfo[]> {
  return Promise.all(
    registry.list().map(async (adapter) => {
      const detected = await adapter.detect({
        env: input.env,
        platform: input.platform,
        path: input.pathFor(adapter.id),
      });
      return agentInfo(adapter, detected);
    }),
  );
}
