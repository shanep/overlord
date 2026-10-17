// What the Fleet does with more than one agent: build the tree for the
// picked agent, name agents on rows once they mix, and the agent filter in
// the View menu.

import type { ReactElement } from 'react';
import { useMemo } from 'react';

import type { AgentId, AgentInfo } from '../../../src/shared/agents.js';
import type { FleetState } from '../../../src/shared/protocol.js';
import { findAgent, offeredAgents, showsAgent, useAgents } from '../agents.js';

import type { FleetNode } from './fleet-rows.js';
import { buildFleetTree } from './fleet-rows.js';

/** The agents among the fleet's sessions, in the host's order, then any it did not describe. */
function listedAgents(state: FleetState, agents: readonly AgentInfo[]): readonly AgentInfo[] {
  const ids = [...new Set(state.sessions.map((session) => session.agent))];
  const order = (id: string): number => {
    const index = agents.findIndex((agent) => agent.id === id);
    return index === -1 ? agents.length : index;
  };
  return ids.toSorted((a, b) => order(a) - order(b)).map((id) => findAgent(agents, id));
}

/**
 * The agent filter in the View menu, shown once the fleet holds sessions of
 * more than one agent, or while it is set so it can be cleared.
 */
function AgentFilter(props: {
  readonly listed: readonly AgentInfo[];
  readonly value: string;
  readonly onChange: (agent: string) => void;
}): ReactElement | null {
  const { listed, value } = props;
  if (listed.length < 2 && value === '') {
    return null;
  }
  const options = [
    { id: '', label: 'All agents' },
    ...listed.map((agent) => ({ id: agent.id, label: `${agent.short} only` })),
  ];
  return (
    <div className="view-menu-group" role="radiogroup" aria-label="Agent">
      {options.map((option) => (
        <label key={option.id}>
          <input
            type="radio"
            name="fleet-agent"
            checked={value === option.id}
            onChange={() => {
              props.onChange(option.id);
            }}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

interface FleetAgents {
  /** The session tree for the picked agent, or for all of them. */
  readonly tree: readonly FleetNode[];
  /** The agents New session can start. */
  readonly offered: readonly AgentInfo[];
  /** Whether a session's row names its agent. */
  readonly showAgent: (agent: AgentId) => boolean;
  /** A note for the View button while the filter hides rows, such as "Codex only". */
  readonly hiding: readonly string[];
  /** The filter for the View menu, or null while there is nothing to pick. */
  readonly filter: ReactElement | null;
}

export function useFleetAgents(
  state: FleetState,
  grouped: boolean,
  picked: string,
  onPick: (agent: string) => void,
): FleetAgents {
  const agents = useAgents();
  const tree = useMemo(() => {
    const shown =
      picked === ''
        ? state
        : { ...state, sessions: state.sessions.filter((session) => session.agent === picked) };
    return buildFleetTree(shown, grouped, (id) => findAgent(agents, id).capabilities.subagents);
  }, [state, grouped, picked, agents]);
  const listed = listedAgents(state, agents);
  const listedIds = listed.map((agent) => agent.id);
  return {
    tree,
    offered: offeredAgents(agents),
    showAgent: (id) => showsAgent(id, listedIds),
    hiding: picked === '' ? [] : [`${findAgent(agents, picked).short} only`],
    filter: <AgentFilter listed={listed} value={picked} onChange={onPick} />,
  };
}
