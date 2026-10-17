// Which agent a session belongs to, and that agent's terminal facet, binary
// and environment, so tabs, stops and handoffs ask the session's own adapter
// instead of assuming Claude Code.

import type { AgentId } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import { agents } from '../agents/index.js';
import type { AgentTerminal } from '../agents/terminals.js';
import { terminalOf } from '../agents/terminals.js';
import type { AgentCli, LiveSources } from '../agents/types.js';
import { mergeEnv } from '../harness/options.js';
import type { LiveProcess } from '../surfaces/live.js';

import { agentEnabled, agentPath, executableFor } from './claude-bin.js';
import type { Runtime } from './runtime.js';

/** The agent a session belongs to. A session the fleet does not list is taken as Claude Code's. */
export function sessionAgent(rt: Runtime, sessionId: string): AgentId {
  const fleet = rt.store.fleetState(rt.clock()).sessions;
  return fleet.find((session) => session.id === sessionId)?.agent ?? CLAUDE_CODE;
}

/** The terminal facet of the session's agent, or null when that agent has none. */
export function sessionTerminal(rt: Runtime, sessionId: string): AgentTerminal | null {
  return terminalOf(sessionAgent(rt, sessionId));
}

/**
 * The agent to start a new session of, or null after saying why it cannot
 * start. Claude Code when no agent is named.
 */
export function agentToStart(rt: Runtime, id: AgentId = CLAUDE_CODE): AgentTerminal | null {
  const found = terminalOf(id);
  const name = agents.get(id)?.name ?? id;
  if (found === null) {
    rt.host.showInfo(`Overlord cannot start ${name} sessions in a terminal.`);
    return null;
  }
  if (!agentEnabled(rt.host.settings, id)) {
    rt.host.showInfo(`${name} is turned off in the overlord.agents setting.`);
    return null;
  }
  return found;
}

/** The command a terminal tab runs for the agent. The host has already looked Claude's up on PATH. */
export function terminalCommand(rt: Runtime, at: AgentTerminal): string {
  const set = agentPath(rt.host.settings, at.adapter.id);
  return set === '' ? at.terminal.command : set;
}

/** The agent's binary and the login shell's environment, for running it outside a tab. */
export async function agentCli(rt: Runtime, at: AgentTerminal): Promise<AgentCli> {
  if (at.adapter.id === CLAUDE_CODE) {
    return rt.claudeCli();
  }
  const env = await rt.loginEnv();
  const { command } = at.terminal;
  const bin = executableFor(agentPath(rt.host.settings, at.adapter.id), env, rt.platform, command);
  return { bin: bin ?? command, env: mergeEnv(env, {}) };
}

function liveSources(rt: Runtime): LiveSources {
  return { paths: rt.paths, exec: rt.surfacesExec, isAlive: rt.isAlive };
}

/** The live process holding a session on this machine, if any, as its agent records it. */
export async function findLive(rt: Runtime, sessionId: string): Promise<LiveProcess | undefined> {
  const at = sessionTerminal(rt, sessionId);
  return at?.terminal.findLive({ ...liveSources(rt), bin: terminalCommand(rt, at) }, sessionId);
}
