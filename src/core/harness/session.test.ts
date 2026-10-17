import { describe, expect, it } from 'vitest';

import {
  fakeRuntime,
  flush,
  payloads,
  rejected,
  resolved,
  resultMessage,
  type FakeQuery,
} from '../../../test/fake-claude/fake-query.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { PermissionDecision, PermissionRequest } from '../../shared/model.js';
import type { AgentEvent } from '../agents/shared/events.js';
import type { AgentRun, RuntimeFacet, StartOptions } from '../agents/shared/runtime.js';
import { EventBus } from '../bus.js';

import type { SessionEvent } from './events.js';
import { PermissionInbox, type PermissionBroker } from './inbox.js';
import { AsyncQueue } from './input-queue.js';
import { AgentSession, toPermissionResult, type SessionConfig } from './session.js';

const CONFIG: SessionConfig = {
  agent: CLAUDE_CODE,
  cwd: '/repo',
  title: 'Task',
  model: 'opus',
  effort: 'high',
  permissionMode: 'manual',
  priced: true,
  env: { PATH: '/bin' },
  extraArgs: { debug: null },
  maxBudgetUsd: 4,
  executablePath: '/fake.mjs',
  sessionId: '00000000-0000-4000-8000-000000000001',
};

interface Setup {
  readonly session: AgentSession;
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
  const fakes = fakeRuntime();
  let ids = 0;
  const session = AgentSession.start(
    {
      runtime: fakes.runtime,
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

describe('AgentSession start', () => {
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
    const fakes = fakeRuntime();
    const inbox = new PermissionInbox();
    const session = AgentSession.start(
      { runtime: fakes.runtime, bus: new EventBus(), broker: inbox },
      CONFIG,
    );
    expect(session.summary()?.startedAt).toBeGreaterThan(1_600_000_000_000);
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

describe('AgentSession messages', () => {
  it('sends prompts and maps SDK messages onto the bus', async () => {
    const { session, query, busEvents, localEvents } = setup();
    session.send('hello');
    await flush();
    expect(query.prompts).toStrictEqual(['hello']);
    expect(session.summary()?.state).toBe('running');
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
    expect(session.summary()?.state).toBe('done');
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
    expect(session.summary()?.model).toBe('sonnet');
    expect(session.summary()?.permissionMode).toBe('plan');
    const usage = await session.contextUsage();
    expect(usage.fill).toBe(0.5);
    expect(session.summary()?.contextFill).toBe(0.5);
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
    expect(session.summary()?.state).toBe('done');
  });

  it('fails when the stream throws', async () => {
    const { session, query } = setup();
    query.fail(new Error('exit code 1'));
    expect(await session.finished).toStrictEqual({ reason: 'failed', error: 'exit code 1' });
    expect(session.summary()?.state).toBe('failed');
    expect(session.isOpen).toBe(false);
  });

  it('stops by aborting the query', async () => {
    const { session, query } = setup();
    session.stop();
    expect(query.options.abortController.signal.aborted).toBe(true);
    expect(await session.finished).toStrictEqual({ reason: 'stopped', error: null });
    expect(session.summary()?.state).toBe('done');
  });
});

describe('AgentSession permissions', () => {
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
    expect(session.summary()?.state).toBe('waiting');
    inbox.resolve('req-1', { behavior: 'allow', ruleId: null });
    expect(await decision).toStrictEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(session.summary()?.state).toBe('running');
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

  it('keeps a session allow and a stopped turn', () => {
    const allow: PermissionDecision = { behavior: 'allow', ruleId: null, scope: 'session' };
    expect(toPermissionResult(allow, {})).toStrictEqual({
      behavior: 'allow',
      updatedInput: {},
      scope: 'session',
    });
    expect(
      toPermissionResult({ behavior: 'allow', ruleId: null, scope: 'once' }, {}),
    ).toStrictEqual({ behavior: 'allow', updatedInput: {} });
    expect(
      toPermissionResult({ behavior: 'deny', message: 'm', ruleId: null, interrupt: true }, {}),
    ).toStrictEqual({ behavior: 'deny', message: 'm', interrupt: true });
  });
});

/** A bare runtime whose agent mints its own id after the start, like Codex. */
class LateRun implements AgentRun {
  sessionId: string | null = null;
  readonly prompts: string[] = [];
  readonly events = new AsyncQueue<AgentEvent>();
  options: StartOptions | null = null;
  readonly send = (text: string): void => {
    this.prompts.push(text);
  };
  readonly endInput = (): void => undefined;
  readonly interrupt = async (): Promise<void> => {
    await resolved(null);
  };
  readonly stop = (): void => {
    this.events.end();
  };
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent, undefined, undefined> {
    return this.events[Symbol.asyncIterator]();
  }
}

function lateSetup(broker: PermissionBroker = new PermissionInbox()): {
  readonly session: AgentSession;
  readonly run: LateRun;
} {
  const run = new LateRun();
  const runtime: RuntimeFacet = {
    start: (options) => {
      run.options = options;
      return run;
    },
    permissionSource: 'runtime',
  };
  const session = AgentSession.start(
    { runtime, bus: new EventBus(), broker, now: () => 7 },
    { ...CONFIG, agent: 'codex' },
  );
  return { session, run };
}

describe('AgentSession with a late id', () => {
  it('holds events until the agent names the session, then replays them', async () => {
    const { session, run } = lateSetup();
    const seen: SessionEvent[] = [];
    session.onEvent((event) => seen.push(event));
    session.send('hi');
    expect(run.prompts).toStrictEqual(['hi']);
    expect(session.id).toBeNull();
    expect(session.summary()).toBeNull();
    expect(session.agents()).toStrictEqual([]);
    expect(session.info()).toBeNull();
    expect(seen).toStrictEqual([]);
    const denied = await run.options?.canUseTool(
      'Bash',
      {},
      {
        signal: new AbortController().signal,
        toolUseId: 't',
        agentId: null,
      },
    );
    expect(denied).toMatchObject({ behavior: 'deny' });
    run.sessionId = 'thread-1';
    run.events.push({ type: 'notice', text: 'ready' });
    await flush();
    expect(session.id).toBe('thread-1');
    expect(session.summary()).toMatchObject({ id: 'thread-1', agent: 'codex', state: 'running' });
    expect(payloads(seen, 'feed.appended').flatMap((feed) => feed.items)).toMatchObject([
      { kind: 'user', text: 'hi' },
      { kind: 'system', text: 'ready' },
    ]);
    session.stop();
    expect(await session.finished).toStrictEqual({ reason: 'stopped', error: null });
  });

  it('asks the inbox as a runtime once the id is known', async () => {
    const asked: PermissionRequest[] = [];
    const broker: PermissionBroker = {
      request: async (request) => {
        asked.push(request);
        return resolved({ behavior: 'allow', ruleId: null });
      },
    };
    const { run } = lateSetup(broker);
    run.sessionId = 'thread-2';
    await run.options?.canUseTool(
      'Bash',
      {},
      {
        signal: new AbortController().signal,
        toolUseId: 't',
        agentId: null,
      },
    );
    expect(asked).toMatchObject([{ sessionId: 'thread-2', agent: 'codex', source: 'runtime' }]);
    expect(asked[0]?.choices).toBeUndefined();
  });

  it('passes the choices the runtime offers to the inbox', async () => {
    const asked: PermissionRequest[] = [];
    const broker: PermissionBroker = {
      request: async (request) => {
        asked.push(request);
        return resolved({ behavior: 'allow', ruleId: null, scope: 'session' });
      },
    };
    const { run } = lateSetup(broker);
    run.sessionId = 'thread-3';
    const result = await run.options?.canUseTool(
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        toolUseId: 't',
        agentId: null,
        choices: ['allow', 'allow_session', 'deny'],
      },
    );
    expect(asked[0]?.choices).toStrictEqual(['allow', 'allow_session', 'deny']);
    expect(result).toStrictEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
      scope: 'session',
    });
  });

  it('refuses live changes the runtime does not offer', async () => {
    const { session } = lateSetup();
    await expect(session.setModel('x')).rejects.toThrow('cannot change model');
    await expect(session.setPermissionMode('x')).rejects.toThrow('cannot change permission mode');
    await expect(session.contextUsage()).rejects.toThrow('does not report');
  });
});
