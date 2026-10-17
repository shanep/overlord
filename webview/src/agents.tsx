// What the webview knows about each agent CLI. Every host message carries the
// list, the App puts it in a context, and views look an agent up by id to
// name it and to leave out what it cannot do.

import type { ReactElement, ReactNode } from 'react';
import { createContext, useContext } from 'react';

import type { AgentCapabilities, AgentId, AgentInfo } from '../../src/shared/agents.js';
import { CLAUDE_CODE } from '../../src/shared/agents.js';

import { CLAUDE_FALLBACK } from './claude-fallback.js';

/** What a cell shows for a number the session's agent does not report, so it never reads as 0. */
export const NOT_REPORTED = '-';

const NO_CAPABILITIES: AgentCapabilities = {
  launch: false,
  terminal: false,
  background: false,
  resume: false,
  fork: false,
  interrupt: false,
  liveModelChange: false,
  livePermissionMode: false,
  approvals: false,
  subagents: false,
  cacheReads: false,
  cacheWrites: false,
  costUsd: false,
  contextInspector: false,
  hooks: false,
  messaging: false,
  handoffs: [],
};

/** An id the host did not describe: named by its id, offering nothing it might not do. */
function unknownAgent(id: AgentId): AgentInfo {
  return {
    id,
    name: id,
    short: id,
    icon: '',
    installed: false,
    version: null,
    capabilities: NO_CAPABILITIES,
    permissionModes: [],
    effortLevels: [],
  };
}

/** Every agent the host knows, or Claude Code alone when the list is empty. */
export function knownAgents(agents: readonly AgentInfo[]): readonly AgentInfo[] {
  return agents.length === 0 ? [CLAUDE_FALLBACK] : agents;
}

/** The agent with this id. Unset means Claude Code, which every session was before there were others. */
export function findAgent(agents: readonly AgentInfo[], id: AgentId | undefined): AgentInfo {
  const wanted = id ?? CLAUDE_CODE;
  const found = agents.find((agent) => agent.id === wanted);
  if (found !== undefined) {
    return found;
  }
  return wanted === CLAUDE_CODE ? CLAUDE_FALLBACK : unknownAgent(wanted);
}

/** True when the host knows Claude Code, which owns plan limits, feature flags and claude.ai. */
export function knowsClaude(agents: readonly AgentInfo[]): boolean {
  return knownAgents(agents).some((agent) => agent.id === CLAUDE_CODE);
}

/**
 * The agents a person can start a session with: the installed ones, and
 * Claude Code always, as before there were others.
 */
export function offeredAgents(agents: readonly AgentInfo[]): readonly AgentInfo[] {
  return knownAgents(agents).filter((agent) => agent.installed || agent.id === CLAUDE_CODE);
}

/** The one agent on offer, or null when there is a choice, so text can name it. */
export function soleAgent(agents: readonly AgentInfo[]): AgentInfo | null {
  const offered = offeredAgents(agents);
  return offered.length === 1 ? (offered[0] ?? null) : null;
}

/**
 * Whether a row names its agent: always for an agent other than Claude Code,
 * and on every row once the list holds more than one agent.
 */
export function showsAgent(agent: AgentId, listed: readonly AgentId[]): boolean {
  return agent !== CLAUDE_CODE || new Set(listed).size > 1;
}

const AgentsContext = createContext<readonly AgentInfo[]>([]);

export function AgentsProvider(props: {
  readonly agents: readonly AgentInfo[];
  readonly children: ReactNode;
}): ReactElement {
  return <AgentsContext value={props.agents}>{props.children}</AgentsContext>;
}

/** The agents list from the latest host message, as sent. */
export function useAgents(): readonly AgentInfo[] {
  return useContext(AgentsContext);
}

/** The agent with this id, or Claude Code when it is unset. */
export function useAgent(id: AgentId | undefined): AgentInfo {
  return findAgent(useAgents(), id);
}
