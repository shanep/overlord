// The permission inbox: every pending approval from every SDK session in one
// place. The host can join it with the hook-based inbox because sessions only
// see the PermissionBroker interface.

import type { PermissionDecision, PermissionRequest } from '../../shared/model.js';
import type { EventBus } from '../bus.js';

export interface PermissionBroker {
  readonly request: (
    request: PermissionRequest,
    signal: AbortSignal,
  ) => Promise<PermissionDecision>;
}

/** Returns a decision to settle a request without asking, or null to ask. */
export type AutoRuleEvaluator = (request: PermissionRequest) => PermissionDecision | null;

export interface AutoDecisionEntry {
  readonly request: PermissionRequest;
  readonly decision: PermissionDecision;
  readonly at: number;
}

export interface InboxOptions {
  readonly bus?: EventBus | null;
  readonly evaluate?: AutoRuleEvaluator | null;
  /** Every auto decision is reported here, so it can be logged with its rule. */
  readonly onAutoDecision?: ((entry: AutoDecisionEntry) => void) | null;
  readonly onChange?: ((pending: readonly PermissionRequest[]) => void) | null;
  readonly now?: () => number;
}

interface Pending {
  readonly request: PermissionRequest;
  readonly settle: (decision: PermissionDecision) => void;
}

export const CANCELLED_MESSAGE = 'Permission request cancelled';

export class PermissionInbox implements PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  private evaluate: AutoRuleEvaluator | null;
  private readonly options: InboxOptions;
  private readonly now: () => number;

  constructor(options: InboxOptions = {}) {
    this.options = options;
    this.evaluate = options.evaluate ?? null;
    this.now = options.now ?? Date.now;
  }

  setEvaluator(evaluate: AutoRuleEvaluator | null): void {
    this.evaluate = evaluate;
  }

  readonly request = async (
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> => {
    const automatic = this.autoDecision(request);
    if (automatic !== null) {
      this.options.onAutoDecision?.({ request, decision: automatic, at: this.now() });
      this.options.bus?.emit('permission.resolved', { requestId: request.id });
      return automatic;
    }
    if (signal?.aborted === true) {
      return { behavior: 'deny', message: CANCELLED_MESSAGE, ruleId: null };
    }
    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.cancel(request.id);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(request.id, {
        request,
        settle: (decision) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(decision);
        },
      });
      this.changed();
    });
  };

  list(): readonly PermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  resolve(id: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return false;
    }
    this.pending.delete(id);
    entry.settle(decision);
    this.options.bus?.emit('permission.resolved', { requestId: id });
    this.changed();
    return true;
  }

  cancel(id: string, message: string = CANCELLED_MESSAGE): boolean {
    return this.resolve(id, { behavior: 'deny', message, ruleId: null });
  }

  cancelSession(sessionId: string, message: string = CANCELLED_MESSAGE): number {
    const ids = this.list()
      .filter((request) => request.sessionId === sessionId)
      .map((request) => request.id);
    return this.cancelIds(ids, message);
  }

  cancelAll(message: string = CANCELLED_MESSAGE): number {
    return this.cancelIds(
      this.list().map((request) => request.id),
      message,
    );
  }

  private cancelIds(ids: readonly string[], message: string): number {
    return ids.filter((id) => this.cancel(id, message)).length;
  }

  private autoDecision(request: PermissionRequest): PermissionDecision | null {
    if (this.evaluate === null) {
      return null;
    }
    try {
      return this.evaluate(request);
    } catch {
      // A broken rule must never approve anything, so fall back to asking.
      return null;
    }
  }

  private changed(): void {
    this.options.onChange?.(this.list());
  }
}
