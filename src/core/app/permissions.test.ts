import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi, type Mock } from 'vitest';

import type { PermissionDecision, PermissionRequest } from '../../shared/model.js';
import type { AutoApproveRule } from '../../shared/protocol.js';
import { EventBus } from '../bus.js';
import { ruleDenyMessage } from '../hooks/mapping.js';

import type { HookPermissions } from './permissions.js';
import { decideByRules, PermissionHub } from './permissions.js';
import { makeEnv, NOW, permissionRequest, writeText, readJson } from './test-helpers/fixtures.js';

const ALLOW: AutoApproveRule = {
  id: 'allow-ls',
  enabled: true,
  behavior: 'allow',
  tool: 'Bash',
  pattern: 'ls*',
  description: 'listing is fine',
};

const DENY: AutoApproveRule = {
  id: 'deny-rm',
  enabled: true,
  behavior: 'deny',
  tool: 'Bash',
  pattern: 'rm *',
  description: 'never delete',
};

class FakeHooks implements HookPermissions {
  rules: readonly AutoApproveRule[] = [];
  pending: PermissionRequest[] = [];
  resolved: { id: string; decision: PermissionDecision }[] = [];

  readonly setRules = (rules: readonly AutoApproveRule[]): void => {
    this.rules = rules;
  };

  readonly pendingRequests = (): PermissionRequest[] => this.pending;

  readonly resolvePermission = (requestId: string, decision: PermissionDecision): boolean => {
    const found = this.pending.some((request) => request.id === requestId);
    if (found) {
      this.resolved.push({ id: requestId, decision });
    }
    return found;
  };
}

async function hub(): Promise<{
  hub: PermissionHub;
  bus: EventBus;
  storageDir: string;
  onChange: Mock<() => void>;
  errors: string[];
}> {
  const env = await makeEnv();
  const bus = new EventBus();
  const errors: string[] = [];
  bus.on('source.error', (error) => {
    errors.push(`${error.source}: ${error.message}`);
  });
  const onChange = vi.fn<() => void>();
  const created = new PermissionHub({
    storageDir: env.storageDir,
    bus,
    clock: (): number => NOW,
    onChange,
  });
  return { hub: created, bus, storageDir: env.storageDir, onChange, errors };
}

describe('decideByRules', () => {
  it('allows, denies with the rule message, or asks', () => {
    const rules = [ALLOW, DENY];
    expect(
      decideByRules(rules, permissionRequest('1', { input: { command: 'ls -la' } })),
    ).toStrictEqual({
      behavior: 'allow',
      ruleId: 'allow-ls',
    });
    const denied = decideByRules(rules, permissionRequest('2', { input: { command: 'rm x' } }));
    expect(denied).toStrictEqual({
      behavior: 'deny',
      ruleId: 'deny-rm',
      message: ruleDenyMessage('deny-rm', 'never delete'),
    });
    expect(
      decideByRules(rules, permissionRequest('3', { input: { command: 'cat x' } })),
    ).toBeNull();
  });
});

describe('PermissionHub', () => {
  it('starts with no rules and answers SDK requests by hand', async () => {
    const { hub: inbox, onChange } = await hub();
    await inbox.load();
    expect(inbox.rules()).toStrictEqual([]);
    const controller = new AbortController();
    const answer = inbox.inbox.request(permissionRequest('a'), controller.signal);
    expect(inbox.list().map((request) => request.id)).toStrictEqual(['a']);
    expect(onChange).toHaveBeenCalled();
    expect(inbox.resolve('a', { behavior: 'allow', ruleId: null })).toBe(true);
    await expect(answer).resolves.toStrictEqual({ behavior: 'allow', ruleId: null });
    expect(inbox.list()).toStrictEqual([]);
    expect(inbox.resolve('a', { behavior: 'allow', ruleId: null })).toBe(false);
  });

  it('merges hook requests, oldest first, and routes answers to the hook server', async () => {
    const { hub: inbox, onChange } = await hub();
    const hooks = new FakeHooks();
    hooks.pending = [permissionRequest('h1', { requestedAt: NOW - 10, source: 'hook' })];
    onChange.mockClear();
    inbox.attachHooks(hooks);
    expect(onChange).toHaveBeenCalledTimes(1);
    void inbox.inbox.request(
      permissionRequest('s1', { requestedAt: NOW }),
      new AbortController().signal,
    );
    expect(inbox.list().map((request) => request.id)).toStrictEqual(['h1', 's1']);
    const deny: PermissionDecision = { behavior: 'deny', message: 'no', ruleId: null };
    expect(inbox.resolve('h1', deny)).toBe(true);
    expect(hooks.resolved).toStrictEqual([{ id: 'h1', decision: deny }]);
    expect(inbox.resolve('missing', deny)).toBe(false);
    inbox.attachHooks(null);
    expect(inbox.list().map((request) => request.id)).toStrictEqual(['s1']);
    expect(inbox.resolve('h1', deny)).toBe(false);
  });

  it('saves, replaces and deletes rules, and pushes them to both sources', async () => {
    const { hub: inbox, storageDir } = await hub();
    const hooks = new FakeHooks();
    inbox.attachHooks(hooks);
    await inbox.saveRule(ALLOW);
    await inbox.saveRule(DENY);
    expect(inbox.rules()).toStrictEqual([ALLOW, DENY]);
    expect(hooks.rules).toStrictEqual([ALLOW, DENY]);
    const changed = { ...ALLOW, description: 'changed' };
    await inbox.saveRule(changed);
    expect(inbox.rules()).toStrictEqual([changed, DENY]);
    const file = await readJson(path.join(storageDir, 'rules.json'));
    expect(file).toStrictEqual({ version: 1, rules: [changed, DENY] });
    await expect(inbox.deleteRule('deny-rm')).resolves.toBe(true);
    await expect(inbox.deleteRule('deny-rm')).resolves.toBe(false);
    expect(inbox.rules()).toStrictEqual([changed]);
    expect(hooks.rules).toStrictEqual([changed]);
  });

  it('auto decides SDK requests by rule and logs each decision', async () => {
    const { hub: inbox, storageDir, bus } = await hub();
    const resolved: string[] = [];
    bus.on('permission.resolved', ({ requestId }) => {
      resolved.push(requestId);
    });
    await inbox.saveRule(ALLOW);
    const decision = await inbox.inbox.request(
      permissionRequest('auto', { input: { command: 'ls' }, agentId: 'agent-1' }),
      new AbortController().signal,
    );
    expect(decision).toStrictEqual({ behavior: 'allow', ruleId: 'allow-ls' });
    expect(resolved).toStrictEqual(['auto']);
    await inbox.flushAudit();
    const text = await readFile(path.join(storageDir, 'audit.jsonl'), 'utf8');
    const entries: unknown[] = text
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(entries).toStrictEqual([
      {
        at: NOW,
        requestId: 'auto',
        sessionId: 's1',
        agentId: 'agent-1',
        toolName: 'Bash',
        ruleId: 'allow-ls',
        behavior: 'allow',
      },
    ]);
    await inbox.deleteRule('allow-ls');
    const asked = inbox.inbox.request(permissionRequest('ask'), new AbortController().signal);
    expect(inbox.list().map((request) => request.id)).toStrictEqual(['ask']);
    inbox.resolve('ask', { behavior: 'allow', ruleId: null });
    await asked;
  });

  it('does not log an automatic decision that names no rule', async () => {
    const { hub: inbox, storageDir } = await hub();
    inbox.inbox.setEvaluator(() => ({ behavior: 'allow', ruleId: null }));
    await inbox.inbox.request(permissionRequest('x'), new AbortController().signal);
    await inbox.flushAudit();
    await expect(readFile(path.join(storageDir, 'audit.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('reports an audit write that fails', async () => {
    const { hub: inbox, storageDir, errors } = await hub();
    await inbox.saveRule(ALLOW);
    // A folder where the log file should be makes the append fail.
    await writeText(path.join(storageDir, 'audit.jsonl', 'blocker'), '');
    await inbox.inbox.request(permissionRequest('x'), new AbortController().signal);
    await inbox.flushAudit();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^permissions: audit log write failed: /u);
  });

  it('always allows: approves, saves an exact rule and answers matching waiting requests', async () => {
    const { hub: inbox, storageDir } = await hub();
    const hooks = new FakeHooks();
    hooks.pending = [
      permissionRequest('same', { input: { command: 'npm test' }, source: 'hook' }),
      permissionRequest('other', { input: { command: 'npm run build' }, source: 'hook' }),
    ];
    inbox.attachHooks(hooks);
    const clicked = inbox.inbox.request(
      permissionRequest('click', { input: { command: ' npm test ' } }),
      new AbortController().signal,
    );
    await expect(inbox.alwaysAllow('click')).resolves.toBe('saved');
    await expect(clicked).resolves.toStrictEqual({ behavior: 'allow', ruleId: null });
    const saved: AutoApproveRule = {
      id: 'allow-click',
      enabled: true,
      behavior: 'allow',
      tool: 'Bash',
      pattern: 'npm test',
      description: 'Added by Always allow',
    };
    expect(inbox.rules()).toStrictEqual([saved]);
    expect(await readJson(path.join(storageDir, 'rules.json'))).toStrictEqual({
      version: 1,
      rules: [saved],
    });
    expect(hooks.resolved).toStrictEqual([
      { id: 'same', decision: { behavior: 'allow', ruleId: 'allow-click' } },
    ]);
    await inbox.flushAudit();
    const text = await readFile(path.join(storageDir, 'audit.jsonl'), 'utf8');
    expect(JSON.parse(text.trim())).toMatchObject({ requestId: 'same', ruleId: 'allow-click' });
  });

  it('always allows a compound command once, saving no rule', async () => {
    const { hub: inbox } = await hub();
    const clicked = inbox.inbox.request(
      permissionRequest('c', { input: { command: 'ls && rm -rf ~' } }),
      new AbortController().signal,
    );
    await expect(inbox.alwaysAllow('c')).resolves.toBe('once');
    await expect(clicked).resolves.toStrictEqual({ behavior: 'allow', ruleId: null });
    expect(inbox.rules()).toStrictEqual([]);
  });

  it('says a request that always allow cannot find is gone', async () => {
    const { hub: inbox } = await hub();
    await expect(inbox.alwaysAllow('missing')).resolves.toBe('gone');
    expect(inbox.rules()).toStrictEqual([]);
  });

  it('loads saved rules and reports a broken rules file without applying any rule', async () => {
    const first = await hub();
    await first.hub.saveRule(DENY);
    const second = new PermissionHub({
      storageDir: first.storageDir,
      bus: first.bus,
      clock: (): number => NOW,
      onChange: vi.fn(),
    });
    await second.load();
    expect(second.rules()).toStrictEqual([DENY]);
    await writeText(path.join(first.storageDir, 'rules.json'), '{broken');
    await second.load();
    expect(second.rules()).toStrictEqual([]);
    expect(first.errors).toStrictEqual([
      `permissions: ${path.join(first.storageDir, 'rules.json')} is not valid JSON`,
    ]);
  });
});
