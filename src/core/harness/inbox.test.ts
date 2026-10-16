import { describe, expect, it, vi } from 'vitest';

import type { PermissionDecision, PermissionRequest } from '../../shared/model.js';
import { EventBus } from '../bus.js';

import { CANCELLED_MESSAGE, PermissionInbox, type AutoDecisionEntry } from './inbox.js';

function request(id: string, sessionId = 's1'): PermissionRequest {
  return {
    id,
    sessionId,
    agentId: sessionId,
    toolName: 'Bash',
    input: { command: 'ls' },
    requestedAt: 1,
    source: 'sdk',
  };
}

const ALLOW: PermissionDecision = { behavior: 'allow', ruleId: null };

describe('PermissionInbox', () => {
  it('holds requests until they are resolved', async () => {
    const bus = new EventBus();
    const resolved: string[] = [];
    bus.on('permission.resolved', (payload) => resolved.push(payload.requestId));
    const changes: number[] = [];
    const inbox = new PermissionInbox({
      bus,
      onChange: (pending): void => {
        changes.push(pending.length);
      },
    });
    const first = inbox.request(request('r1'));
    const second = inbox.request(request('r2'));
    expect(inbox.list().map((entry) => entry.id)).toStrictEqual(['r1', 'r2']);
    expect(inbox.resolve('r2', { behavior: 'deny', message: 'no', ruleId: 'rule-9' })).toBe(true);
    expect(await second).toStrictEqual({ behavior: 'deny', message: 'no', ruleId: 'rule-9' });
    expect(inbox.resolve('r2', ALLOW)).toBe(false);
    expect(inbox.resolve('r1', ALLOW)).toBe(true);
    expect(await first).toStrictEqual(ALLOW);
    expect(inbox.list()).toStrictEqual([]);
    expect(resolved).toStrictEqual(['r2', 'r1']);
    expect(changes).toStrictEqual([1, 2, 1, 0]);
  });

  it('settles requests at once when a rule matches and logs it', async () => {
    const bus = new EventBus();
    const resolved: string[] = [];
    bus.on('permission.resolved', (payload) => resolved.push(payload.requestId));
    const log: AutoDecisionEntry[] = [];
    const rule: PermissionDecision = { behavior: 'allow', ruleId: 'allow-ls' };
    const inbox = new PermissionInbox({
      bus,
      evaluate: (entry): PermissionDecision | null => (entry.toolName === 'Bash' ? rule : null),
      onAutoDecision: (entry): void => {
        log.push(entry);
      },
      now: (): number => 77,
    });
    expect(await inbox.request(request('r1'))).toBe(rule);
    expect(log).toStrictEqual([{ request: request('r1'), decision: rule, at: 77 }]);
    expect(resolved).toStrictEqual(['r1']);
    expect(inbox.list()).toStrictEqual([]);
    inbox.setEvaluator(null);
    const pending = inbox.request(request('r2'));
    expect(inbox.list()).toHaveLength(1);
    inbox.resolve('r2', ALLOW);
    await pending;
  });

  it('asks when a rule returns null or throws', () => {
    const inbox = new PermissionInbox({
      evaluate: (entry): PermissionDecision | null => {
        if (entry.id === 'boom') {
          throw new Error('bad rule');
        }
        return null;
      },
    });
    void inbox.request(request('ok'));
    void inbox.request(request('boom'));
    expect(inbox.list().map((entry) => entry.id)).toStrictEqual(['ok', 'boom']);
    expect(inbox.cancelAll()).toBe(2);
  });

  it('cancels by id, by session and all at once', async () => {
    const inbox = new PermissionInbox();
    const a = inbox.request(request('a', 's1'));
    const b = inbox.request(request('b', 's2'));
    const c = inbox.request(request('c', 's1'));
    const d = inbox.request(request('d', 's3'));
    expect(inbox.cancel('a', 'gone')).toBe(true);
    expect(await a).toStrictEqual({ behavior: 'deny', message: 'gone', ruleId: null });
    expect(inbox.cancelSession('s1')).toBe(1);
    expect(await c).toStrictEqual({ behavior: 'deny', message: CANCELLED_MESSAGE, ruleId: null });
    expect(inbox.cancelSession('s9')).toBe(0);
    expect(inbox.cancel('missing')).toBe(false);
    expect(inbox.cancelSession('s3', 'session over')).toBe(1);
    expect(await d).toStrictEqual({ behavior: 'deny', message: 'session over', ruleId: null });
    expect(inbox.cancelAll('all done')).toBe(1);
    expect(await b).toStrictEqual({ behavior: 'deny', message: 'all done', ruleId: null });
    expect(inbox.cancelAll()).toBe(0);
  });

  it('cancels when the signal aborts, and refuses aborted signals', async () => {
    const inbox = new PermissionInbox();
    const controller = new AbortController();
    const pending = inbox.request(request('r1'), controller.signal);
    expect(inbox.list()).toHaveLength(1);
    controller.abort();
    expect(await pending).toStrictEqual({
      behavior: 'deny',
      message: CANCELLED_MESSAGE,
      ruleId: null,
    });
    expect(inbox.list()).toStrictEqual([]);
    expect(await inbox.request(request('r2'), controller.signal)).toStrictEqual({
      behavior: 'deny',
      message: CANCELLED_MESSAGE,
      ruleId: null,
    });
    expect(inbox.list()).toStrictEqual([]);
  });

  it('stops listening to the signal once resolved', async () => {
    const inbox = new PermissionInbox();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = inbox.request(request('r1'), controller.signal);
    inbox.resolve('r1', ALLOW);
    expect(await pending).toStrictEqual(ALLOW);
    expect(remove).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(inbox.list()).toStrictEqual([]);
  });
});
