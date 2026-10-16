// Every source error, from the bus, kept in a short list the status can show.

import type { EventBus } from '../bus.js';

export interface AppError {
  readonly source: string;
  readonly message: string;
  readonly at: number;
}

export const MAX_ERRORS = 50;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ErrorLog {
  private readonly entries: AppError[] = [];

  constructor(
    private readonly clock: () => number,
    private readonly limit: number = MAX_ERRORS,
  ) {}

  /** Records every source.error the bus carries. Returns the unsubscribe function. */
  attach(bus: EventBus): () => void {
    return bus.on('source.error', ({ source, message }) => {
      this.add(source, message);
    });
  }

  /** A repeat of an error already in the list moves it to the end with the new time. */
  add(source: string, message: string): void {
    const index = this.entries.findIndex(
      (entry) => entry.source === source && entry.message === message,
    );
    if (index !== -1) {
      this.entries.splice(index, 1);
    }
    this.entries.push({ source, message, at: this.clock() });
    if (this.entries.length > this.limit) {
      this.entries.shift();
    }
  }

  /** Oldest first. */
  list(): readonly AppError[] {
    return [...this.entries];
  }
}
