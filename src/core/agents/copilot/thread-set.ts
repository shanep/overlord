// Every thread of one Copilot session, and which thread an event belongs to.
// Main thread and session events carry no agentId. A subagent's events do,
// and they find the thread its subagent.started opened through the parent
// tool call id they carry.

import type { Envelope, SubagentStart } from './events.js';
import type { Thread } from './threads.js';
import { childThread, mainThread, startSubagent } from './threads.js';

/** agentMetrics names the main thread this way. */
const MAIN_AGENT_KEY = 'main';

/** The parentToolCallId a subagent's event data carries, or null. */
function parentToolCallOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('parentToolCallId' in data)) {
    return null;
  }
  const value = data.parentToolCallId;
  return typeof value === 'string' ? value : null;
}

export class ThreadSet {
  private readonly sessionId: string;
  private readonly threads = new Map<string, Thread>();
  /** Envelope agent ids, and the tool calls that started subagents, mapped to their thread. */
  private readonly aliases = new Map<string, string>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.threads.set(sessionId, mainThread(sessionId));
  }

  /** How many subagents the session has had. */
  get subagentCount(): number {
    return this.threads.size - 1;
  }

  main(): Thread {
    const main = this.threads.get(this.sessionId);
    if (main === undefined) {
      throw new Error('the main thread is always there');
    }
    return main;
  }

  get(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  /** The main thread first, then subagents in the order they started. */
  list(): Thread[] {
    return [...this.threads.values()];
  }

  /** The thread an event belongs to, made when the event names one not seen before. */
  resolve(event: Envelope, fileAgentId: string): Thread {
    const agentId = event.agentId ?? (fileAgentId === this.sessionId ? null : fileAgentId);
    if (agentId === null || agentId === this.sessionId) {
      return this.main();
    }
    const known = this.threads.get(this.aliases.get(agentId) ?? agentId);
    if (known !== undefined) {
      return known;
    }
    const parentCall = parentToolCallOf(event.data);
    const started = parentCall === null ? undefined : this.aliases.get(parentCall);
    const startedThread = started === undefined ? undefined : this.threads.get(started);
    if (startedThread !== undefined) {
      this.aliases.set(agentId, startedThread.id);
      return startedThread;
    }
    const created = childThread(agentId, this.main(), null);
    this.threads.set(agentId, created);
    return created;
  }

  /** Opens a subagent's thread once, keyed by the tool call that spawned it. */
  start(parent: Thread, data: SubagentStart, at: number): void {
    const id = data.toolCallId;
    if (!this.threads.has(id)) {
      this.threads.set(id, startSubagent(parent, data, at));
      this.aliases.set(id, id);
    }
  }

  /** The thread an agentMetrics key names, or null when no thread has it. */
  forMetrics(key: string): string | null {
    if (key === MAIN_AGENT_KEY) {
      return this.sessionId;
    }
    const id = this.aliases.get(key) ?? key;
    return this.threads.has(id) ? id : null;
  }

  /** Ends the open turns: the main thread's alone, or every thread's when the whole session stops. */
  closeTurns(scope: 'main' | 'all'): void {
    for (const thread of this.threads.values()) {
      if (scope === 'all' || thread.id === this.sessionId) {
        thread.open = false;
        thread.wantsTools = false;
      }
    }
  }

  /** The session stopped, so every subagent still going ended with it. */
  endAll(at: number): void {
    this.closeTurns('all');
    for (const thread of this.threads.values()) {
      if (thread.id !== this.sessionId) {
        thread.endedAt ??= at;
      }
    }
  }

  anyOpen(): boolean {
    return [...this.threads.values()].some((thread) => thread.open);
  }

  /** The earliest or latest event time across every thread, or 0 before any. */
  edge(which: 'first' | 'last'): number {
    const times = [...this.threads.values()]
      .map((thread) => (which === 'first' ? thread.firstAt : thread.lastAt))
      .filter((at): at is number => at !== null);
    if (times.length === 0) {
      return 0;
    }
    return which === 'first' ? Math.min(...times) : Math.max(...times);
  }
}
