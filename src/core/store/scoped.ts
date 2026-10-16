// Values keyed by session and then agent, so everything for a session can be
// dropped at once when it goes away.

export class SessionScoped<T> {
  private readonly bySession = new Map<string, Map<string, T>>();

  get(sessionId: string, agentId: string): T | undefined {
    return this.bySession.get(sessionId)?.get(agentId);
  }

  set(sessionId: string, agentId: string, value: T): void {
    let agents = this.bySession.get(sessionId);
    if (agents === undefined) {
      agents = new Map();
      this.bySession.set(sessionId, agents);
    }
    agents.set(agentId, value);
  }

  getOrCreate(sessionId: string, agentId: string, create: () => T): T {
    const existing = this.get(sessionId, agentId);
    if (existing !== undefined) {
      return existing;
    }
    const created = create();
    this.set(sessionId, agentId, created);
    return created;
  }

  /** Values for one session, in insertion order. */
  inSession(sessionId: string): T[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])];
  }

  /** Values for every session, in insertion order. */
  all(): T[] {
    return [...this.bySession.values()].flatMap((agents) => [...agents.values()]);
  }

  deleteSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
