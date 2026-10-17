// Fixed-capacity buffer that keeps the newest items. Pushing past capacity
// overwrites the oldest item, so memory stays flat on long sessions.

function checkCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`Capacity must be a whole number of at least 1, got ${String(capacity)}.`);
  }
}

export class RingBuffer<T> {
  private readonly items: T[] = [];
  /** Next slot to write, which is also the oldest item once the buffer is full. */
  private head = 0;

  constructor(readonly capacity: number) {
    checkCapacity(capacity);
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    // Until the buffer fills, head equals the length, so this appends.
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
  }

  /** Oldest first. */
  toArray(): T[] {
    return [...this.items.slice(this.head), ...this.items.slice(0, this.head)];
  }
}

/** A Map that drops its oldest entries past capacity. Updating a key keeps its age. */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(readonly capacity: number) {
    checkCapacity(capacity);
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    this.map.set(key, value);
    for (const oldest of this.map.keys()) {
      if (this.map.size <= this.capacity) {
        break;
      }
      this.map.delete(oldest);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  /** Oldest first. */
  values(): V[] {
    return [...this.map.values()];
  }
}
