import { describe, expect, it } from 'vitest';

import {
  fakeQueries,
  flush,
  payloads,
  rejected,
  resolved,
  resultMessage,
  type FakeQuery,
} from '../../../test/fake-claude/fake-query.js';
import type { PermissionDecision, PermissionRequest } from '../../shared/model.js';
import { EventBus } from '../bus.js';

import type { SessionEvent } from './events.js';
import { PermissionInbox, type PermissionBroker } from './inbox.js';
import { SdkSession, toPermissionResult, type SessionConfig } from './session.js';

const CONFIG: SessionConfig = {
  cwd: '/repo',
  title: 'Task',
  model: 'opus',
  effort: 'high',
  permissionMode: 'manual',
  env: { PATH: '/bin' },
  extraArgs: { debug: null },
  maxBudgetUsd: 4,
  executablePath: '/fake.mjs',
  sessionId: '00000000-0000-4000-8000-000000000001',
};

interface Setup {
  readonly session: SdkSession;
  readonly query: FakeQuery;
  readonly bus: EventBus;
  readonly busEvents: SessionEvent[];
  readonly localEvents: SessionEvent[];
}

function setup(
  broker: PermissionBroker = new PermissionInbox(),
  config: SessionConfig = CONFIG,
): Setup {
  const bus = new EventBus();
  const busEvents: SessionEvent[] = [];
  bus.on('session.upserted', (payload) => busEvents.push({ name: 'session.upserted', payload }));
  bus.on('agent.upserted', (payload) => busEvents.push({ name: 'agent.upserted', payload }));
  bus.on('feed.appended', (payload) => busEvents.push({ name: 'feed.appended', payload }));
  bus.on('permission.requested', (payload) =>
    busEvents.push({ name: 'permission.requested', payload }),
  );
  const fakes = fakeQueries();
  let ids = 0;
  const session = SdkSession.start(
    {
      queryFunction: fakes.queryFunction,
      bus,
      broker,
      now: () => 500,
      newId: () => {
        ids += 1;
        return `req-${String(ids)}`;
      },
    },
    config,
  );
  const localEvents: SessionEvent[] = [];
  session.onEvent((event) => localEvents.push(event));
  const [query] = fakes.queries;
  if (query === undefined) {
    throw new Error('no query was created');
  }
  return { session, query, bus, busEvents, localEvents };
}

describe('SdkSession start', () => {
  it('passes the config to the query and publishes the start', () => {
    const { session, query, busEvents } = setup();
    expect(session.id).toBe(CONFIG.sessionId);
    expect(query.options).toMatchObject({
      cwd: '/repo',
      sessionId: CONFIG.sessionId,
      env: { PATH: '/bin' },
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
      extraArgs: { debug: null },
      maxBudgetUsd: 4,
      executablePath: '/fake.mjs',
    });
    expect(busEvents.map((event) => event.name)).toStrictEqual([
      'session.upserted',
      'agent.upserted',
    ]);
    expect(session.summary()).toMatchObject({ id: CONFIG.sessionId, state: 'idle', title: 'Task' });
    expect(session.agents().map((agent) => agent.id)).toStrictEqual([CONFIG.sessionId]);
    expect(session.info()).toBeNull();
    expect(session.isOpen).toBe(true);
    expect(session.finished).toBe(session.finished);
  });

  it('makes a UUID and leaves the mode unset when not given', () => {
    const { session, query } = setup(new PermissionInbox(), {
      ...CONFIG,
      sessionId: undefined,
      permissionMode: null,
    });
    expect(session.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(query.options.permissionMode).toBeNull();
  });

  it('defaults the clock and ids', async () => {
    const fakes = fakeQueries();
    const inbox = new PermissionInbox();
    const session = SdkSession.start(
      { queryFunction: fakes.queryFunction, bus: new EventBus(), broker: inbox },
      CONFIG,
    );
    expect(session.summary().startedAt).toBeGreaterThan(1_600_000_000_000);
    const query = fakes.queries[0];
    const decision = query?.options.canUseTool(
      'Bash',
      {},
      {
        signal: new AbortController().signal,
        toolUseId: 't',
        agentId: null,
      },
    );
    await flush();
    const [pending] = inbox.list();
    expect(pending?.id).toMatch(/^[\da-f-]{36}$/);
    inbox.resolve(pending?.id ?? '', { behavior: 'allow', ruleId: null });
    expect(await decision).toStrictEqual({ behavior: 'allow', updatedInput: {} });
  });
});

describe('SdkSession messages', () => {
  it('sends prompts and maps SDK messages onto the bus', async () => {
    const { session, query, busEvents, localEvents } = setup();
    session.send('hello');
    await flush();
    expect(query.prompts).toStrictEqual(['hello']);
    expect(session.summary().state).toBe('running');
    query.emit({
      type: 'system',
      subtype: 'init',
      session_id: CONFIG.sessionId,
      model: 'claude-fake',
      cwd: '/repo',
      tools: [],
      permissionMode: 'default',
      mcp_servers: [],
    });
    query.emit({ type: 'unknown' });
    query.emit(resultMessage());
    await flush();
    expect(session.info()?.model).toBe('claude-fake');
    expect(session.summary().state).toBe('done');
    expect(payloads(localEvents, 'turn.result')).toHaveLength(1);
    expect(payloads(busEvents, 'feed.appended').map((feed) => feed.items[0]?.kind)).toStrictEqual([
      'user',
      'system',
    ]);
  });

  it('stops delivering to a removed listener', async () => {
    const { session, query } = setup();
    const seen: string[] = [];
    const off = session.onEvent((event) => seen.push(event.name));
    session.send('x');
    off();
    query.emit(resultMessage());
    await flush();
    expect(seen).toStrictEqual(['feed.appended', 'session.upserted', 'agent.upserted']);
  });

  it('forwards control calls', async () => {
    const { session, query, localEvents } = setup();
    await session.interrupt();
    await session.setModel('sonnet');
    await session.setPermissionMode('manual');
    await session.setPermissionMode('plan');
    expect(query.interrupts).toBe(1);
    expect(query.models).toStrictEqual(['sonnet']);
    expect(query.modes).toStrictEqual(['default', 'plan']);
    expect(session.summary().model).toBe('sonnet');
    expect(session.summary().permissionMode).toBe('plan');
    const usage = await session.contextUsage();
    expect(usage.fill).toBe(0.5);
    expect(session.summary().contextFill).toBe(0.5);
    expect(payloads(localEvents, 'session.upserted').at(-1)?.contextFill).toBe(0.5);
  });

  it('completes when the stream ends after close', async () => {
    const { session, query } = setup();
    session.close();
    expect(session.isOpen).toBe(false);
    expect(() => {
      session.send('late');
    }).toThrow('The input queue has ended');
    await flush();
    expect(query.inputEnded).toBe(true);
    query.end();
    expect(await session.finished).toStrictEqual({ reason: 'completed', error: null });
    expect(session.summary().state).toBe('done');
  });

  it('fails when the stream throws', async () => {
    const { session, query } = setup();
    query.fail(new Error('exit code 1'));
    expect(await session.finished).toStrictEqual({ reason: 'failed', error: 'exit code 1' });
    expect(session.summary().state).toBe('failed');
    expect(session.isOpen).toBe(false);
  });

  it('stops by aborting the query', async () => {
    const { session, query } = setup();
    session.stop();
    expect(query.options.abortController.signal.aborted).toBe(true);
    expect(await session.finished).toStrictEqual({ reason: 'stopped', error: null });
    expect(session.summary().state).toBe('done');
  });
});

describe('SdkSession permissions', () => {
  it('asks the broker and maps an allow', async () => {
    const inbox = new PermissionInbox();
    const { session, query, busEvents } = setup(inbox);
    session.send('go');
    const decision = query.options.canUseTool(
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        toolUseId: 'toolu_1',
        agentId: null,
      },
    );
    const expected: PermissionRequest = {
      id: 'req-1',
      agent: 'claude-code',
      sessionId: CONFIG.sessionId ?? '',
      agentId: CONFIG.sessionId ?? '',
      toolName: 'Bash',
      input: { command: 'ls' },
      requestedAt: 500,
      source: 'sdk',
    };
    expect(inbox.list()).toStrictEqual([expected]);
    expect(payloads(busEvents, 'permission.requested')).toStrictEqual([expected]);
    expect(session.summary().state).toBe('waiting');
    inbox.resolve('req-1', { behavior: 'allow', ruleId: null });
    expect(await decision).toStrictEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(session.summary().state).toBe('running');
  });

  it('maps a deny and a broker failure, and keeps the subagent id', async () => {
    const asked: PermissionRequest[] = [];
    let mode: 'deny' | 'throw' = 'deny';
    const broker: PermissionBroker = {
      request: async (request) => {
        asked.push(request);
        if (mode === 'throw') {
          return rejected(new Error('broker down'));
        }
        return resolved({ behavior: 'deny', message: 'not that', ruleId: 'r' });
      },
    };
    const { query } = setup(broker);
    const context = { signal: new AbortController().signal, toolUseId: 't', agentId: 'task_7' };
    expect(await query.options.canUseTool('Bash', {}, context)).toStrictEqual({
      behavior: 'deny',
      message: 'not that',
    });
    expect(asked[0]?.agentId).toBe('task_7');
    mode = 'throw';
    expect(await query.options.canUseTool('Bash', {}, context)).toStrictEqual({
      behavior: 'deny',
      message: 'broker down',
    });
  });

  it('cancels open prompts when stopped', async () => {
    const inbox = new PermissionInbox();
    const { session, query } = setup(inbox);
    const decision = query.options.canUseTool(
      'Bash',
      {},
      {
        signal: new AbortController().signal,
        toolUseId: 't',
        agentId: null,
      },
    );
    expect(inbox.list()).toHaveLength(1);
    session.stop();
    expect(await decision).toStrictEqual({
      behavior: 'deny',
      message: 'Permission request cancelled',
    });
    expect(inbox.list()).toStrictEqual([]);
  });

  it('cancels when the SDK aborts the prompt', async () => {
    const inbox = new PermissionInbox();
    const { query } = setup(inbox);
    const controller = new AbortController();
    const decision = query.options.canUseTool(
      'Bash',
      {},
      {
        signal: controller.signal,
        toolUseId: 't',
        agentId: null,
      },
    );
    controller.abort();
    expect(await decision).toMatchObject({ behavior: 'deny' });
  });
});

describe('toPermissionResult', () => {
  it('maps decisions to the SDK shape', () => {
    const allow: PermissionDecision = { behavior: 'allow', ruleId: 'x' };
    expect(toPermissionResult(allow, { a: 1 })).toStrictEqual({
      behavior: 'allow',
      updatedInput: { a: 1 },
    });
    expect(toPermissionResult({ behavior: 'deny', message: 'm', ruleId: null }, {})).toStrictEqual({
      behavior: 'deny',
      message: 'm',
    });
  });
});
