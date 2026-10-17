// The agents that can open in a terminal tab, each with its terminal facet,
// for the code that starts, polls and stops sessions in tabs.

import type { AgentId } from '../../shared/agents.js';

import type { AgentAdapter, TerminalFacet } from './types.js';

import { agents } from './index.js';

export interface AgentTerminal {
  readonly adapter: AgentAdapter;
  readonly terminal: TerminalFacet;
}

function withTerminal(adapter: AgentAdapter | null): AgentTerminal | null {
  return adapter?.terminal === undefined ? null : { adapter, terminal: adapter.terminal };
}

/** The adapter and terminal facet for an agent, or null when it cannot open in a tab. */
export function terminalOf(id: AgentId): AgentTerminal | null {
  return withTerminal(agents.get(id));
}

/** Every agent that can open in a tab, in the order they were registered. */
export function terminalAgents(): readonly AgentTerminal[] {
  return agents.list().flatMap((adapter) => withTerminal(adapter) ?? []);
}
