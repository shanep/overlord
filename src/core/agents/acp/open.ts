// Opens the ACP session for a run: session/new for a new one, or for a
// resume session/fork, session/resume or session/load, whichever the agent
// advertises.

import type {
  ClientContext,
  InitializeResponse,
  NewSessionRequest,
  SessionConfigOption,
  SessionModeState,
} from '@agentclientprotocol/sdk';

import type { StartOptions } from '../shared/runtime.js';

export interface OpenedSession {
  readonly sessionId: string;
  readonly modes: SessionModeState | null;
  readonly configOptions: readonly SessionConfigOption[];
}

function opened(
  sessionId: string,
  reply: {
    readonly modes?: SessionModeState | null;
    readonly configOptions?: SessionConfigOption[] | null;
  },
): OpenedSession {
  return { sessionId, modes: reply.modes ?? null, configOptions: reply.configOptions ?? [] };
}

/**
 * Opens the session. session/load replays the old conversation as updates,
 * so `replaying` is told when that starts and ends.
 */
export async function openSession(
  agent: ClientContext,
  init: InitializeResponse,
  options: Pick<StartOptions, 'cwd' | 'resumeId' | 'fork'>,
  replaying: (on: boolean) => void,
): Promise<OpenedSession> {
  const { cwd, resumeId } = options;
  const capabilities = init.agentCapabilities ?? {};
  const sessions = capabilities.sessionCapabilities ?? {};
  const base: NewSessionRequest = { cwd, mcpServers: [] };
  if (resumeId === null) {
    const created = await agent.request('session/new', base);
    return opened(created.sessionId, created);
  }
  if (options.fork) {
    if (sessions.fork === undefined || sessions.fork === null) {
      throw new Error('This agent cannot fork a session');
    }
    const forked = await agent.request('session/fork', { ...base, sessionId: resumeId });
    return opened(forked.sessionId, forked);
  }
  if (sessions.resume !== undefined && sessions.resume !== null) {
    const resumed = await agent.request('session/resume', { ...base, sessionId: resumeId });
    return opened(resumeId, resumed);
  }
  if (capabilities.loadSession !== true) {
    throw new Error('This agent cannot resume a session');
  }
  replaying(true);
  try {
    const loaded = await agent.request('session/load', { ...base, sessionId: resumeId });
    return opened(resumeId, loaded);
  } finally {
    replaying(false);
  }
}
