// Turns the raw messages from every transcript into the log people read. A
// send and its delivery are one message, so the delivery goes. A notice that
// an agent finished goes when the agent's report is there. Both sides get a
// readable name: an agent by its description, a session by its title. A
// matched send and delivery also tell which session an address reached, so a
// uds: address or session name reads as that session's title.

import type { AgentMessage, MessageRoute } from '../../shared/protocol.js';

import type { ExtractedMessage, RawMessage } from './extract.js';
import { BROADCAST, MAIN } from './extract.js';

export const MAIN_NAME = 'Main conversation';
export const EVERYONE = 'Everyone';

const AGENT_ID = /^a[0-9a-f]{15,}$/u;
const SOCKET_PREFIX = 'uds:';
const PID = /^\d+$/u;

export interface Directory {
  readonly sessionTitle: (sessionId: string) => string;
  /** A subagent's description, or null when nothing describes it. */
  readonly agentName: (sessionId: string, agentId: string) => string | null;
}

export interface NamedMessages {
  /** In no particular order. */
  readonly messages: readonly AgentMessage[];
  /** Traffic between sessions only, busiest first. */
  readonly routes: readonly MessageRoute[];
}

function agentKey(sessionId: string, agentId: string): string {
  return `${sessionId}\n${agentId}`;
}

class Namer {
  /** An address another session used, to the session it reached. */
  private readonly peers = new Map<string, string>();
  /** Agent descriptions the records give, for agents the directory does not know. */
  private readonly hinted = new Map<string, string>();

  constructor(private readonly directory: Directory) {}

  /** True for the session's own main thread, its agents and broadcasts. */
  isLocal(party: string, sessionId: string): boolean {
    return (
      party === MAIN ||
      party === BROADCAST ||
      AGENT_ID.test(party) ||
      this.directory.agentName(sessionId, party) !== null
    );
  }

  /** A send in one session matched a delivery in another, so each side's address is known. */
  link(send: RawMessage, delivery: RawMessage): void {
    if (send.sessionId === delivery.sessionId) {
      return;
    }
    if (!this.isLocal(send.to, send.sessionId)) {
      this.peers.set(send.to, delivery.sessionId);
    }
    if (!this.isLocal(delivery.from, delivery.sessionId)) {
      this.peers.set(delivery.from, send.sessionId);
    }
  }

  hint(entry: ExtractedMessage): void {
    const { message, senderName } = entry;
    if (senderName !== null) {
      this.hinted.set(agentKey(message.sessionId, message.from), senderName);
    }
  }

  name(party: string, sessionId: string): string {
    if (party === MAIN) {
      return MAIN_NAME;
    }
    if (party === BROADCAST) {
      return EVERYONE;
    }
    const agent =
      this.directory.agentName(sessionId, party) ?? this.hinted.get(agentKey(sessionId, party));
    if (agent !== undefined) {
      return agent;
    }
    const peer = this.peers.get(party);
    if (peer !== undefined) {
      return this.directory.sessionTitle(peer);
    }
    if (AGENT_ID.test(party)) {
      return `Agent ${party.slice(0, 8)}`;
    }
    const pid = party.slice(party.lastIndexOf('/') + 1).replace(/\.sock$/u, '');
    return party.startsWith(SOCKET_PREFIX) && PID.test(pid) ? `Session with pid ${pid}` : party;
  }

  named(message: RawMessage): AgentMessage {
    return {
      ...message,
      sessionTitle: this.directory.sessionTitle(message.sessionId),
      fromName: this.name(message.from, message.sessionId),
      toName: this.name(message.to, message.sessionId),
    };
  }
}

function compareRoutes(left: MessageRoute, right: MessageRoute): number {
  if (left.count !== right.count) {
    return right.count - left.count;
  }
  return right.lastAt - left.lastAt;
}

function countRoutes(pairs: readonly (readonly [string, string, number])[]): MessageRoute[] {
  const routes = new Map<string, MessageRoute>();
  for (const [from, to, at] of pairs) {
    const key = JSON.stringify([from, to]);
    const old = routes.get(key);
    routes.set(key, {
      from,
      to,
      count: (old?.count ?? 0) + 1,
      lastAt: Math.max(old?.lastAt ?? 0, at),
    });
  }
  return [...routes.values()].toSorted(compareRoutes);
}

/** One copy of each message with both sides named, and the routes between sessions. */
export function nameMessages(
  entries: readonly ExtractedMessage[],
  directory: Directory,
): NamedMessages {
  const namer = new Namer(directory);
  const sends = new Map<string, RawMessage>();
  const handedBack = new Set<string>();
  for (const entry of entries) {
    const { message, textKey } = entry;
    namer.hint(entry);
    if (message.kind === 'send' && !sends.has(textKey)) {
      sends.set(textKey, message);
    }
    if (message.kind === 'hand-back') {
      handedBack.add(agentKey(message.sessionId, message.from));
    }
  }
  const kept: RawMessage[] = [];
  for (const { message, textKey, routine } of entries) {
    const send = message.kind === 'receive' ? sends.get(textKey) : undefined;
    if (send !== undefined) {
      namer.link(send, message);
    } else if (!(routine && handedBack.has(agentKey(message.sessionId, message.from)))) {
      kept.push(message);
    }
  }
  const messages = kept.map((message) => namer.named(message));
  const crossing = messages.flatMap((message): (readonly [string, string, number])[] => {
    if (message.kind === 'send' && !namer.isLocal(message.to, message.sessionId)) {
      return [[message.sessionTitle, message.toName, message.at]];
    }
    if (message.kind === 'receive' && !namer.isLocal(message.from, message.sessionId)) {
      return [[message.fromName, message.sessionTitle, message.at]];
    }
    return [];
  });
  return { messages, routes: countRoutes(crossing) };
}
