// One permission inbox over two sources: SDK sessions Overlord launched ask
// through PermissionInbox (canUseTool), and every other session asks through
// the PermissionRequest hook. Auto-approve rules apply to both, and every
// automatic decision lands in the audit log.

import type { PermissionDecision, PermissionRequest } from '../../shared/model.js';
import type { AutoApproveRule } from '../../shared/protocol.js';
import type { EventBus } from '../bus.js';
import type { AutoDecisionEntry } from '../harness/inbox.js';
import { PermissionInbox } from '../harness/inbox.js';
import { AuditLog } from '../hooks/audit.js';
import { ruleDenyMessage } from '../hooks/mapping.js';
import { alwaysAllowRule, findMatchingRule } from '../hooks/rules.js';

import { messageOf } from './errors.js';
import { readRules, storagePath, writeRules } from './storage.js';

/** The part of HookServer the inbox uses. */
export interface HookPermissions {
  readonly setRules: (rules: readonly AutoApproveRule[]) => void;
  readonly pendingRequests: () => PermissionRequest[];
  readonly resolvePermission: (requestId: string, decision: PermissionDecision) => boolean;
}

export interface PermissionHubOptions {
  readonly storageDir: string;
  readonly bus: EventBus;
  readonly clock: () => number;
  readonly onChange: () => void;
}

const SOURCE = 'permissions';

/**
 * What Always allow did: saved a rule and approved the request, approved it
 * once because no rule can cover it, or found the request already gone.
 */
export type AlwaysAllowOutcome = 'saved' | 'once' | 'gone';

/** The decision the rules make for a request, or null to ask the user. Deny rules win. */
export function decideByRules(
  rules: readonly AutoApproveRule[],
  request: PermissionRequest,
): PermissionDecision | null {
  const rule = findMatchingRule(rules, request.toolName, request.input);
  if (rule === null) {
    return null;
  }
  if (rule.behavior === 'allow') {
    return { behavior: 'allow', ruleId: rule.id };
  }
  return { behavior: 'deny', ruleId: rule.id, message: ruleDenyMessage(rule.id, rule.description) };
}

export class PermissionHub {
  readonly inbox: PermissionInbox;
  readonly audit: AuditLog;
  private pendingAudit: Promise<void> = Promise.resolve();
  private readonly options: PermissionHubOptions;
  private readonly rulesFile: string;
  private hooks: HookPermissions | null = null;
  private current: readonly AutoApproveRule[] = [];

  constructor(options: PermissionHubOptions) {
    this.options = options;
    this.rulesFile = storagePath(options.storageDir, 'rules');
    this.audit = new AuditLog(storagePath(options.storageDir, 'audit'));
    this.inbox = new PermissionInbox({
      bus: options.bus,
      now: options.clock,
      onAutoDecision: (entry): void => {
        this.logAuto(entry);
      },
      onChange: (): void => {
        options.onChange();
      },
    });
  }

  /** Reads rules.json. A broken file leaves no rules active and reports why. */
  async load(): Promise<void> {
    try {
      this.apply(await readRules(this.rulesFile));
    } catch (error) {
      this.apply([]);
      this.report(messageOf(error));
    }
  }

  rules(): readonly AutoApproveRule[] {
    return this.current;
  }

  /** Connects the hook server, or disconnects it with null. */
  attachHooks(hooks: HookPermissions | null): void {
    this.hooks = hooks;
    hooks?.setRules(this.current);
    this.options.onChange();
  }

  /** Every pending request from both sources, oldest first. */
  list(): readonly PermissionRequest[] {
    const fromHooks = this.hooks?.pendingRequests() ?? [];
    return [...this.inbox.list(), ...fromHooks].toSorted(
      (left, right) => left.requestedAt - right.requestedAt,
    );
  }

  /** Answers a request from whichever source holds it. False when nobody does. */
  resolve(requestId: string, decision: PermissionDecision): boolean {
    if (this.inbox.resolve(requestId, decision)) {
      return true;
    }
    return this.hooks?.resolvePermission(requestId, decision) ?? false;
  }

  /**
   * Approves the request and saves an allow rule so its kind never asks
   * again, then lets the new rule answer every other request still waiting.
   */
  async alwaysAllow(requestId: string): Promise<AlwaysAllowOutcome> {
    const request = this.list().find((item) => item.id === requestId);
    if (request === undefined) {
      return 'gone';
    }
    // Answer first, so the request cannot time out while the rule is written.
    this.resolve(requestId, { behavior: 'allow', ruleId: null });
    const rule = alwaysAllowRule(request.toolName, request.input, `allow-${request.id}`);
    if (rule === null) {
      return 'once';
    }
    await this.saveRule(rule);
    for (const other of this.list()) {
      const decision = decideByRules(this.current, other);
      if (decision !== null) {
        this.resolve(other.id, decision);
        this.logAuto({ request: other, decision, at: this.options.clock() });
      }
    }
    return 'saved';
  }

  /** Adds the rule, or replaces the one with the same id in place. */
  async saveRule(rule: AutoApproveRule): Promise<void> {
    const exists = this.current.some((item) => item.id === rule.id);
    const next = exists
      ? this.current.map((item) => (item.id === rule.id ? rule : item))
      : [...this.current, rule];
    await this.store(next);
  }

  /** False when no rule had that id. */
  async deleteRule(ruleId: string): Promise<boolean> {
    const next = this.current.filter((item) => item.id !== ruleId);
    if (next.length === this.current.length) {
      return false;
    }
    await this.store(next);
    return true;
  }

  private async store(rules: readonly AutoApproveRule[]): Promise<void> {
    await writeRules(this.rulesFile, rules);
    this.apply(rules);
  }

  private apply(rules: readonly AutoApproveRule[]): void {
    this.current = rules;
    this.inbox.setEvaluator(
      rules.length === 0
        ? null
        : (request): PermissionDecision | null => decideByRules(rules, request),
    );
    this.hooks?.setRules(rules);
    this.options.onChange();
  }

  private logAuto(entry: AutoDecisionEntry): void {
    const { request, decision } = entry;
    if (decision.ruleId === null) {
      return;
    }
    const write = this.audit
      .append({
        at: entry.at,
        requestId: request.id,
        sessionId: request.sessionId,
        agentId: request.agentId,
        toolName: request.toolName,
        ruleId: decision.ruleId,
        behavior: decision.behavior,
      })
      .catch((error: unknown) => {
        this.report(`audit log write failed: ${messageOf(error)}`);
      });
    // Decisions must not wait on the disk, so writes run in the background and
    // flushAudit lets callers (and tests) wait for them.
    this.pendingAudit = this.pendingAudit.then(async () => write);
  }

  /** Resolves once every audit write started so far has finished or failed. */
  async flushAudit(): Promise<void> {
    await this.pendingAudit;
  }

  private report(message: string): void {
    this.options.bus.emit('source.error', { source: SOURCE, message });
  }
}
