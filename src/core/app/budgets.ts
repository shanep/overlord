// Token budgets set on sessions from their Fleet rows. Each one remembers
// whether its warning has been shown, so a reload does not warn again about
// a session that went over before it.

import type { StoredBudget } from './storage.js';
import { readBudgets, writeBudgets } from './storage.js';

export interface TokenBudgetsOptions {
  /** budgets.json in the storage folder. */
  readonly file: string;
  readonly onChange: () => void;
  readonly report: (source: string, message: string) => void;
}

const SOURCE = 'budgets';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TokenBudgets {
  private readonly options: TokenBudgetsOptions;
  private budgets: Readonly<Record<string, StoredBudget>> = {};
  private queue: Promise<void> = Promise.resolve();

  constructor(options: TokenBudgetsOptions) {
    this.options = options;
  }

  async load(): Promise<void> {
    await this.enqueue(async () => {
      try {
        this.budgets = { ...(await readBudgets(this.options.file)), ...this.budgets };
      } catch (error) {
        this.options.report(SOURCE, messageOf(error));
      }
    });
    this.options.onChange();
  }

  /** Each session's budget in tokens, by session id. */
  tokens(): Readonly<Record<string, number>> {
    return Object.fromEntries(Object.entries(this.budgets).map(([id, { tokens }]) => [id, tokens]));
  }

  get(sessionId: string): number | null {
    return this.budgets[sessionId]?.tokens ?? null;
  }

  warned(sessionId: string): boolean {
    return this.budgets[sessionId]?.warned ?? false;
  }

  /** Sets a session's budget, or clears it with null. A new budget warns again once it is used up. */
  async set(sessionId: string, tokens: number | null): Promise<void> {
    const rest = Object.fromEntries(
      Object.entries(this.budgets).filter(([id]) => id !== sessionId),
    );
    this.budgets = tokens === null ? rest : { ...rest, [sessionId]: { tokens, warned: false } };
    await this.save();
  }

  async markWarned(sessionId: string): Promise<void> {
    const budget = this.budgets[sessionId];
    if (budget === undefined || budget.warned) {
      return;
    }
    this.budgets = { ...this.budgets, [sessionId]: { ...budget, warned: true } };
    await this.save();
  }

  /** Resolves once every queued write has landed, so nothing writes after teardown. */
  async idle(): Promise<void> {
    await this.queue;
  }

  /** Writes the budgets as they stand when the write runs, so queued saves end on the latest. */
  private async save(): Promise<void> {
    this.options.onChange();
    await this.enqueue(async () => {
      try {
        await writeBudgets(this.options.file, this.budgets);
      } catch (error) {
        this.options.report(SOURCE, messageOf(error));
      }
    });
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task);
    this.queue = next.catch((error: unknown) => {
      this.options.report(SOURCE, messageOf(error));
    });
    return next;
  }
}
