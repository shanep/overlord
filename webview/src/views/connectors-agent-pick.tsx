// Which agent a registry server goes to. With Claude Code alone there is
// nothing to pick and the install form looks as it always did.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { AgentId, AgentInfo } from '../../../src/shared/agents.js';
import { CLAUDE_CODE } from '../../../src/shared/agents.js';
import { findAgent, useAgents } from '../agents.js';

export interface AgentChoice {
  /** Every agent the server can go to, Claude Code first. */
  readonly targets: readonly AgentInfo[];
  /** The one picked. */
  readonly target: AgentInfo;
  readonly pick: (id: AgentId) => void;
}

/** The agents a server can be added to, named, and the one picked, Claude Code to start. */
export function useAgentChoice(ids: readonly AgentId[]): AgentChoice {
  const agents = useAgents();
  const targets = (ids.length === 0 ? [CLAUDE_CODE] : ids).map((id) => findAgent(agents, id));
  const [picked, pick] = useState<AgentId>(targets[0]?.id ?? CLAUDE_CODE);
  const target = targets.find((agent) => agent.id === picked) ?? findAgent(agents, CLAUDE_CODE);
  return { targets, target, pick };
}

/** A select of the agents, shown only when there is more than one. */
export function AgentPick(props: { readonly choice: AgentChoice }): ReactElement | null {
  const { targets, target, pick } = props.choice;
  if (targets.length < 2) {
    return null;
  }
  return (
    <label className="field">
      <span>Add to</span>
      <select
        value={target.id}
        onChange={(event) => {
          pick(event.target.value);
        }}
      >
        {targets.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** What Install does, in the words of the one agent or of the one picked. */
export function InstallSameAs(props: { readonly several: boolean }): ReactElement {
  return props.several ? (
    <>
      the <code>mcp add</code> command of the agent you pick
    </>
  ) : (
    <code>claude mcp add --scope user</code>
  );
}
