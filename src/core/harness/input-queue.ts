// An async queue used as the SDK's streaming prompt. The SDK pulls from it
// for the life of the session, so follow-up messages can be pushed at any
// time, and ending it closes the CLI's stdin.

export class AsyncQueue<T> implements AsyncIterable<T, undefined, undefined> {
  private readonly items: T[] = [];
  private waiter: ((result: IteratorResult<T, undefined>) => void) | null = null;
  private closed = false;

  get ended(): boolean {
    return this.closed;
  }

  push(item: T): void {
    if (this.closed) {
      throw new Error('The input queue has ended');
    }
    const waiter = this.waiter;
    if (waiter === null) {
      this.items.push(item);
      return;
    }
    this.waiter = null;
    waiter({ done: false, value: item });
  }

  end(): void {
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined, undefined> {
    return { next: async () => this.next() };
  }

  private async next(): Promise<IteratorResult<T, undefined>> {
    const [item] = this.items;
    if (item !== undefined) {
      this.items.shift();
      return { done: false, value: item };
    }
    if (this.closed) {
      return { done: true, value: undefined };
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}
