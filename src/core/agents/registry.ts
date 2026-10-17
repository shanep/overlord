// The agent adapters Overlord knows, looked up by id, and what the webview is
// told about each one.

import type { AgentId, AgentInfo } from '../../shared/agents.js';

import type { AgentAdapter, Detected, ShellEnv } from './types.js';

/** The custom agents, in a holder a registry and its copies share. */
interface CustomAgents {
  current: readonly AgentAdapter[];
}

/**
 * The built-in adapters, which never change, and the custom ACP agents from
 * the overlord.customAgents setting, which setCustom swaps when the setting
 * changes. Every lookup goes through get and list, so callers see a swap at
 * once without holding a new registry.
 */
export class AgentRegistry {
  private readonly builtIn: ReadonlyMap<AgentId, AgentAdapter>;
  private readonly custom: CustomAgents;

  constructor(adapters: readonly AgentAdapter[], custom?: CustomAgents) {
    this.builtIn = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.custom = custom ?? { current: [] };
  }

  /** The adapter for an id, or null when no adapter has it. */
  get(id: AgentId): AgentAdapter | null {
    return this.builtIn.get(id) ?? this.custom.current.find((adapter) => adapter.id === id) ?? null;
  }

  /** Every adapter: the built-in ones in the order they were registered, then the custom ones. */
  list(): readonly AgentAdapter[] {
    return [...this.builtIn.values(), ...this.custom.current];
  }

  /** The ids of the built-in adapters, which a custom agent may not take. */
  builtInIds(): ReadonlySet<AgentId> {
    return new Set(this.builtIn.keys());
  }

  /**
   * Replaces the custom agents. One whose id a built-in adapter or an earlier
   * custom one already has is left out, since parseCustomAgents has warned
   * about it already.
   */
  setCustom(adapters: readonly AgentAdapter[]): void {
    const kept: AgentAdapter[] = [];
    for (const adapter of adapters) {
      if (!this.builtIn.has(adapter.id) && !kept.some((other) => other.id === adapter.id)) {
        kept.push(adapter);
      }
    }
    this.custom.current = kept;
  }

  /** A copy with one built-in adapter changed, which still sees every later setCustom. */
  withBuiltIn(id: AgentId, change: (adapter: AgentAdapter) => AgentAdapter): AgentRegistry {
    const adapters = [...this.builtIn.values()].map((adapter) =>
      adapter.id === id ? change(adapter) : adapter,
    );
    return new AgentRegistry(adapters, this.custom);
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
