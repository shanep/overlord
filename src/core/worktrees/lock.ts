// One-at-a-time queues keyed by repository. Fetches, worktree adds, rebases
// and pushes touch refs every worktree of a repository shares, so Overlord
// runs them in order per repository instead of letting them race.

export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Runs task once every task queued earlier under the same key has settled. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task);
    // The next task waits for this one to settle, whether it worked or not.
    const tail = Promise.allSettled([next]);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
