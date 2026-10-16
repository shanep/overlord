import { describe, expect, it } from 'vitest';

import { payloads } from '../../../test/fake-claude/fake-query.js';
import { ZERO_USAGE, type SessionState } from '../../shared/model.js';

import type { EndReason } from './events.js';
import { MessageMapper } from './mapper.js';

const SID = 'session-1';

const END_CASES: readonly (readonly [EndReason, 'success' | 'error', SessionState])[] = [
  ['failed', 'success', 'failed'],
  ['stopped', 'success', 'done'],
  ['completed', 'success', 'done'],
  ['completed', 'error', 'failed'],
  ['stopped', 'error', 'done'],
];

const TASK_CASES: readonly (readonly [string, SessionState])[] = [
  ['completed', 'done'],
  ['stopped', 'done'],
  ['failed', 'failed'],
];

interface Harness {
  readonly mapper: MessageMapper;
  readonly setClock: (value: number) => void;
}

function makeMapper(): Harness {
  let clock = 1000;
  const mapper = new MessageMapper({
    sessionId: SID,
    cwd: '/repo',
    title: 'Fix the bug',
    model: 'opus',
    effort: 'high',
    permissionMode: 'default',
    now: (): number => clock,
  });
  return {
    mapper,
    setClock: (value): void => {
      clock = value;
    },
  };
}

function init(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: SID,
    model: 'claude-fake-1',
    cwd: '/repo/wt',
    tools: ['Bash', 'Read'],
    permissionMode: 'acceptEdits',
    mcp_servers: [{ name: 'github', status: 'connected' }],
    claude_code_version: '2.1.301',
    ...overrides,
  };
}

function assistant(
  content: unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      id: 'msg_1',
      model: 'claude-fake-1',
      content,
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    },
    parent_tool_use_id: null,
    request_id: 'req_1',
    ...overrides,
  };
}

function toolResult(id: string, content: unknown, isError?: boolean): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content,
          ...(isError === undefined ? {} : { is_error: isError }),
        },
      ],
    },
  };
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    duration_ms: 1500,
    total_cost_usd: 0.25,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 1,
    },
    result: 'All done',
    ...overrides,
  };
}

function taskStarted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task_1',
    tool_use_id: 'toolu_agent',
    description: 'Explore',
    subagent_type: 'Explore',
    ...overrides,
  };
}

describe('MessageMapper lifecycle', () => {
  it('starts idle with the main agent', () => {
    const { mapper } = makeMapper();
    const events = mapper.started();
    expect(events.map((event) => event.name)).toStrictEqual(['session.upserted', 'agent.upserted']);
    expect(mapper.summary()).toStrictEqual({
      id: SID,
      surface: 'overlord',
      title: 'Fix the bug',
      cwd: '/repo',
      state: 'idle',
      startedAt: 1000,
      updatedAt: 1000,
      usage: ZERO_USAGE,
      costUsd: 0,
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
      pid: null,
      transcriptPath: null,
      gitBranch: null,
      version: null,
      agentCount: 0,
      contextFill: null,
    });
    expect(payloads(events, 'agent.upserted')).toStrictEqual([
      {
        id: SID,
        sessionId: SID,
        parentAgentId: null,
        parentToolUseId: null,
        agentType: 'main',
        description: 'Fix the bug',
        spawnDepth: 0,
        background: false,
        state: 'idle',
        startedAt: 1000,
        endedAt: null,
        transcriptPath: null,
        usage: ZERO_USAGE,
        toolCallCount: 0,
        currentTool: null,
        model: 'opus',
      },
    ]);
    expect(mapper.info()).toBeNull();
    expect(mapper.agentList()).toHaveLength(1);
  });

  it('records the prompt and goes to running', () => {
    const { mapper, setClock } = makeMapper();
    setClock(2000);
    const events = mapper.prompted('hello');
    expect(payloads(events, 'feed.appended')).toStrictEqual([
      {
        sessionId: SID,
        agentId: SID,
        items: [{ kind: 'user', text: 'hello', id: `${SID}:1`, at: 2000 }],
      },
    ]);
    expect(mapper.summary().state).toBe('running');
    expect(mapper.summary().updatedAt).toBe(2000);
    expect(payloads(events, 'agent.upserted').map((agent) => agent.state)).toStrictEqual([
      'running',
    ]);
    const next = mapper.prompted('again');
    expect(payloads(next, 'feed.appended')[0]?.items[0]?.id).toBe(`${SID}:2`);
  });

  it('only toggles waiting while a turn is active', () => {
    const { mapper } = makeMapper();
    expect(mapper.waiting(1)).toStrictEqual([]);
    mapper.prompted('go');
    expect(payloads(mapper.waiting(1), 'session.upserted')[0]?.state).toBe('waiting');
    expect(payloads(mapper.waiting(2), 'session.upserted')[0]?.state).toBe('waiting');
    expect(payloads(mapper.waiting(0), 'session.upserted')[0]?.state).toBe('running');
    mapper.translate(result());
    expect(mapper.waiting(1)).toStrictEqual([]);
  });

  it('applies live model, mode and context changes', () => {
    const { mapper } = makeMapper();
    const model = mapper.modelChanged('sonnet');
    expect(payloads(model, 'session.upserted')[0]?.model).toBe('sonnet');
    expect(payloads(model, 'agent.upserted')[0]?.model).toBe('sonnet');
    expect(
      payloads(mapper.permissionModeChanged('plan'), 'session.upserted')[0]?.permissionMode,
    ).toBe('plan');
    expect(payloads(mapper.contextMeasured(0.5), 'session.upserted')[0]?.contextFill).toBe(0.5);
  });

  it.each(END_CASES)('ends with reason %s after a %s turn as %s', (reason, turn, expected) => {
    const { mapper, setClock } = makeMapper();
    mapper.translate(turn === 'error' ? result({ is_error: true }) : result());
    setClock(5000);
    const events = mapper.ended(reason);
    expect(payloads(events, 'session.upserted')[0]?.state).toBe(expected);
    const agent = payloads(events, 'agent.upserted')[0];
    expect(agent?.state).toBe(expected);
    expect(agent?.endedAt).toBe(5000);
    expect(agent?.currentTool).toBeNull();
  });

  it('ignores messages it does not know', () => {
    const { mapper } = makeMapper();
    expect(mapper.translate(null)).toStrictEqual([]);
    expect(mapper.translate({ type: 'stream_event' })).toStrictEqual([]);
    expect(mapper.translate({ type: 'system', subtype: 'status' })).toStrictEqual([]);
  });
});

describe('MessageMapper init', () => {
  it('copies the init fields and writes one feed line', () => {
    const { mapper } = makeMapper();
    const events = mapper.translate(init());
    const summary = payloads(events, 'session.upserted')[0];
    expect(summary?.model).toBe('claude-fake-1');
    expect(summary?.cwd).toBe('/repo/wt');
    expect(summary?.permissionMode).toBe('acceptEdits');
    expect(summary?.version).toBe('2.1.301');
    expect(payloads(events, 'agent.upserted')[0]?.model).toBe('claude-fake-1');
    expect(payloads(events, 'feed.appended')[0]?.items).toStrictEqual([
      {
        kind: 'system',
        text: 'Started claude-fake-1 in /repo/wt with 2 tools; MCP: github (connected)',
        id: `${SID}:1`,
        at: 1000,
      },
    ]);
    expect(mapper.info()).toStrictEqual({
      model: 'claude-fake-1',
      cwd: '/repo/wt',
      tools: ['Bash', 'Read'],
      permissionMode: 'acceptEdits',
      mcpServers: [{ name: 'github', status: 'connected' }],
      version: '2.1.301',
    });
    const again = mapper.translate(init({ model: 'other' }));
    expect(payloads(again, 'feed.appended')).toStrictEqual([]);
    expect(mapper.info()?.model).toBe('other');
  });

  it('keeps known values when init lacks them', () => {
    const { mapper } = makeMapper();
    const events = mapper.translate(
      init({ permissionMode: 'weird', claude_code_version: undefined, mcp_servers: [], tools: [] }),
    );
    const summary = payloads(events, 'session.upserted')[0];
    expect(summary?.permissionMode).toBe('default');
    expect(summary?.version).toBeNull();
    expect(mapper.info()?.version).toBeNull();
    expect(payloads(events, 'feed.appended')[0]?.items[0]).toMatchObject({
      text: 'Started claude-fake-1 in /repo/wt with 0 tools; MCP: none',
    });
  });
});

describe('MessageMapper assistant and tools', () => {
  it('maps blocks to feed items, a request and a tool call', () => {
    const { mapper } = makeMapper();
    const events = mapper.translate(
      assistant([
        { type: 'thinking', thinking: 'hmm', signature: '' },
        { type: 'text', text: 'Reading' },
        { type: 'image', source: {} },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
      ]),
    );
    expect(events.map((event) => event.name)).toStrictEqual([
      'request.recorded',
      'agent.upserted',
      'tool.upserted',
      'agent.upserted',
      'feed.appended',
    ]);
    expect(payloads(events, 'request.recorded')).toStrictEqual([
      {
        messageId: 'msg_1',
        requestId: 'req_1',
        sessionId: SID,
        agentId: SID,
        model: 'claude-fake-1',
        timestamp: 1000,
        usage: { input: 10, output: 4, cacheRead: 3, cacheCreation: 2, thinking: 0 },
        ttftMs: null,
        durationMs: null,
        costUsd: null,
      },
    ]);
    expect(payloads(events, 'tool.upserted')).toStrictEqual([
      {
        id: 'toolu_1',
        sessionId: SID,
        agentId: SID,
        name: 'Read',
        input: { file_path: 'a.ts' },
        startedAt: 1000,
        endedAt: null,
        ok: null,
        resultPreview: null,
      },
    ]);
    const agents = payloads(events, 'agent.upserted');
    expect(agents[0]?.usage).toStrictEqual({
      input: 10,
      output: 4,
      cacheRead: 3,
      cacheCreation: 2,
      thinking: 0,
    });
    expect(agents[1]?.toolCallCount).toBe(1);
    expect(agents[1]?.currentTool).toBe('Read');
    expect(payloads(events, 'feed.appended')[0]?.items).toStrictEqual([
      { kind: 'thinking', text: 'hmm', id: `${SID}:1`, at: 1000 },
      { kind: 'text', text: 'Reading', id: `${SID}:2`, at: 1000 },
      { kind: 'tool_use', name: 'Read', input: { file_path: 'a.ts' }, id: `${SID}:3`, at: 1000 },
    ]);
  });

  it('records each API message once and adds usage up', () => {
    const { mapper } = makeMapper();
    mapper.translate(assistant([{ type: 'text', text: 'a' }]));
    const repeat = mapper.translate(assistant([{ type: 'text', text: 'b' }]));
    expect(payloads(repeat, 'request.recorded')).toStrictEqual([]);
    const second = mapper.translate(
      assistant([], {
        message: { id: 'msg_2', model: 'm', content: [], usage: null },
        request_id: undefined,
      }),
    );
    expect(payloads(second, 'request.recorded')[0]?.requestId).toBeNull();
    expect(payloads(second, 'request.recorded')[0]?.usage).toStrictEqual(ZERO_USAGE);
    expect(payloads(second, 'feed.appended')).toStrictEqual([]);
    const third = mapper.translate(
      assistant([], {
        message: {
          id: 'msg_3',
          model: 'm',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    );
    expect(payloads(third, 'agent.upserted')[0]?.usage).toStrictEqual({
      input: 11,
      output: 5,
      cacheRead: 3,
      cacheCreation: 2,
      thinking: 0,
    });
  });

  it('counts tool calls per agent', () => {
    const { mapper } = makeMapper();
    mapper.translate(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    const events = mapper.translate(
      assistant([{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }], {
        message: {
          id: 'msg_9',
          model: 'm',
          content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }],
        },
      }),
    );
    expect(payloads(events, 'agent.upserted').at(-1)?.toolCallCount).toBe(2);
  });

  it('finishes tool calls from tool results', () => {
    const { mapper, setClock } = makeMapper();
    mapper.translate(assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]));
    setClock(1500);
    const long = 'x'.repeat(250);
    const events = mapper.translate(
      toolResult('toolu_1', [{ type: 'text', text: long }, { type: 'image' }]),
    );
    expect(payloads(events, 'tool.upserted')).toStrictEqual([
      {
        id: 'toolu_1',
        sessionId: SID,
        agentId: SID,
        name: 'Read',
        input: {},
        startedAt: 1000,
        endedAt: 1500,
        ok: true,
        resultPreview: `${'x'.repeat(200)}...`,
      },
    ]);
    expect(payloads(events, 'agent.upserted')[0]?.currentTool).toBeNull();
    expect(payloads(events, 'feed.appended')[0]?.items).toStrictEqual([
      { kind: 'tool_result', toolUseId: 'toolu_1', ok: true, text: long, id: `${SID}:2`, at: 1500 },
    ]);
  });

  it('marks errors and joins text blocks', () => {
    const { mapper } = makeMapper();
    mapper.translate(assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }]));
    const events = mapper.translate(
      toolResult(
        'toolu_1',
        [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        true,
      ),
    );
    const call = payloads(events, 'tool.upserted')[0];
    expect(call?.ok).toBe(false);
    expect(call?.resultPreview).toBe('a\nb');
  });

  it('feeds results for unknown tools without a tool call', () => {
    const { mapper } = makeMapper();
    const events = mapper.translate(toolResult('nope', undefined, false));
    expect(events.map((event) => event.name)).toStrictEqual(['feed.appended']);
    expect(payloads(events, 'feed.appended')[0]?.items[0]).toMatchObject({ text: '', ok: true });
    const mixed = mapper.translate({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'note' }] },
    });
    expect(mixed).toStrictEqual([]);
    const plain = mapper.translate({
      type: 'user',
      message: { role: 'user', content: 'typed text' },
    });
    expect(plain).toStrictEqual([]);
    const stringResult = mapper.translate(toolResult('nope', 'plain'));
    expect(payloads(stringResult, 'feed.appended')[0]?.items[0]).toMatchObject({ text: 'plain' });
  });
});

describe('MessageMapper results', () => {
  it('publishes the turn result and adds usage across turns', () => {
    const { mapper } = makeMapper();
    mapper.prompted('go');
    const events = mapper.translate(result());
    expect(events.map((event) => event.name)).toStrictEqual([
      'session.upserted',
      'agent.upserted',
      'turn.result',
    ]);
    expect(payloads(events, 'turn.result')).toStrictEqual([
      {
        ok: true,
        subtype: 'success',
        text: 'All done',
        costUsd: 0.25,
        turns: 3,
        durationMs: 1500,
        usage: { input: 100, output: 20, cacheRead: 7, cacheCreation: 1, thinking: 0 },
      },
    ]);
    expect(mapper.summary().state).toBe('done');
    expect(mapper.summary().costUsd).toBe(0.25);
    mapper.translate(result({ total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2 } }));
    expect(mapper.summary().costUsd).toBe(0.5);
    expect(mapper.summary().usage).toStrictEqual({
      input: 101,
      output: 22,
      cacheRead: 7,
      cacheCreation: 1,
      thinking: 0,
    });
  });

  it('marks failed turns and explains them in the feed', () => {
    const { mapper } = makeMapper();
    const events = mapper.translate(
      result({
        subtype: 'error_max_turns',
        is_error: true,
        result: undefined,
        errors: ['too many', 'turns'],
      }),
    );
    expect(payloads(events, 'turn.result')[0]).toMatchObject({
      ok: false,
      text: 'too many; turns',
    });
    expect(payloads(events, 'session.upserted')[0]?.state).toBe('failed');
    expect(payloads(events, 'agent.upserted')[0]?.state).toBe('failed');
    expect(payloads(events, 'feed.appended')[0]?.items[0]).toMatchObject({
      kind: 'system',
      text: 'Turn failed (error_max_turns): too many; turns',
    });
    const bare = mapper.translate(result({ is_error: true, result: undefined }));
    expect(payloads(bare, 'turn.result')[0]?.text).toBeNull();
    expect(payloads(bare, 'feed.appended')[0]?.items[0]).toMatchObject({
      text: 'Turn failed (success): ',
    });
  });
});

describe('MessageMapper subagents', () => {
  it('adds a subagent node and routes its messages', () => {
    const { mapper } = makeMapper();
    const started = mapper.translate(taskStarted());
    expect(payloads(started, 'agent.upserted')).toStrictEqual([
      {
        id: 'task_1',
        sessionId: SID,
        parentAgentId: SID,
        parentToolUseId: 'toolu_agent',
        agentType: 'Explore',
        description: 'Explore',
        spawnDepth: 1,
        background: false,
        state: 'running',
        startedAt: 1000,
        endedAt: null,
        transcriptPath: null,
        usage: ZERO_USAGE,
        toolCallCount: 0,
        currentTool: null,
        model: null,
      },
    ]);
    expect(payloads(started, 'session.upserted')[0]?.agentCount).toBe(1);
    const routed = mapper.translate(
      assistant([{ type: 'tool_use', id: 'sub_tool', name: 'Grep', input: {} }], {
        parent_tool_use_id: 'toolu_agent',
      }),
    );
    expect(payloads(routed, 'tool.upserted')[0]?.agentId).toBe('task_1');
    expect(payloads(routed, 'feed.appended')[0]?.agentId).toBe('task_1');
    const finished = mapper.translate(toolResult('sub_tool', 'ok'));
    expect(payloads(finished, 'feed.appended')[0]?.agentId).toBe('task_1');
    expect(payloads(finished, 'agent.upserted')[0]?.id).toBe('task_1');
  });

  it('uses explicit agent ids and fields when given', () => {
    const { mapper } = makeMapper();
    const started = mapper.translate(
      taskStarted({
        task_id: 'task_2',
        tool_use_id: undefined,
        subagent_type: undefined,
        task_type: 'local_bash',
        is_backgrounded: true,
        spawn_depth: 2,
        parent_task_id: 'task_1',
      }),
    );
    expect(payloads(started, 'agent.upserted')[0]).toMatchObject({
      parentAgentId: 'task_1',
      parentToolUseId: null,
      agentType: 'local_bash',
      spawnDepth: 2,
      background: true,
    });
    const typeless = mapper.translate(taskStarted({ task_id: 'task_3', subagent_type: undefined }));
    expect(payloads(typeless, 'agent.upserted')[0]?.agentType).toBe('task');
    const routed = mapper.translate(
      assistant([{ type: 'text', text: 'x' }], {
        agent_id: 'task_2',
        parent_tool_use_id: 'unknown',
      }),
    );
    expect(payloads(routed, 'request.recorded')[0]?.agentId).toBe('task_2');
    const stray = mapper.translate(
      assistant([{ type: 'text', text: 'y' }], {
        message: { id: 'msg_x', model: 'm', content: [{ type: 'text', text: 'y' }] },
        agent_id: 'ghost',
      }),
    );
    expect(payloads(stray, 'agent.upserted')).toStrictEqual([]);
    const strayTool = mapper.translate(
      assistant([{ type: 'tool_use', id: 'ghost_tool', name: 'Bash', input: {} }], {
        message: {
          id: 'msg_g',
          model: 'm',
          content: [{ type: 'tool_use', id: 'ghost_tool', name: 'Bash', input: {} }],
        },
        agent_id: 'ghost',
      }),
    );
    expect(strayTool.map((event) => event.name)).toStrictEqual([
      'request.recorded',
      'tool.upserted',
      'feed.appended',
    ]);
    const strayResult = mapper.translate(toolResult('ghost_tool', 'done'));
    expect(strayResult.map((event) => event.name)).toStrictEqual([
      'tool.upserted',
      'feed.appended',
    ]);
    expect(payloads(stray, 'feed.appended')[0]?.agentId).toBe('ghost');
    const unrouted = mapper.translate(
      assistant([{ type: 'text', text: 'z' }], {
        message: { id: 'msg_y', model: 'm', content: [] },
        parent_tool_use_id: 'unknown',
      }),
    );
    expect(payloads(unrouted, 'request.recorded')[0]?.agentId).toBe(SID);
  });

  it.each(TASK_CASES)('maps a %s task to %s', (status, state) => {
    const { mapper, setClock } = makeMapper();
    mapper.translate(taskStarted());
    setClock(3000);
    const events = mapper.translate({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task_1',
      status,
      summary: 's',
    });
    expect(payloads(events, 'agent.upserted')[0]).toMatchObject({
      state,
      endedAt: 3000,
      currentTool: null,
    });
  });

  it('ignores notifications for unknown tasks', () => {
    const { mapper } = makeMapper();
    expect(
      mapper.translate({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'x',
        status: 'completed',
        summary: '',
      }),
    ).toStrictEqual([]);
  });
});

describe('MessageMapper rate limits and compaction', () => {
  it('tracks the five hour and seven day windows', () => {
    const { mapper } = makeMapper();
    const five = mapper.translate({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 0.25,
        resetsAt: 1_800_000_000,
      },
    });
    expect(payloads(five, 'rateLimits.updated')).toStrictEqual([
      { fiveHourPct: 25, sevenDayPct: null, resetsAt: 1_800_000_000_000 },
    ]);
    const seven = mapper.translate({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5 },
    });
    expect(payloads(seven, 'rateLimits.updated')).toStrictEqual([
      { fiveHourPct: 25, sevenDayPct: 50, resetsAt: 1_800_000_000_000 },
    ]);
    const sparse = mapper.translate({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
    });
    expect(payloads(sparse, 'rateLimits.updated')).toStrictEqual([
      { fiveHourPct: 25, sevenDayPct: 50, resetsAt: 1_800_000_000_000 },
    ]);
    const sevenSparse = mapper.translate({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day' },
    });
    expect(payloads(sevenSparse, 'rateLimits.updated')[0]?.sevenDayPct).toBe(50);
    const ms = mapper.translate({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: 1_900_000_000_000,
      },
    });
    expect(payloads(ms, 'rateLimits.updated')[0]?.resetsAt).toBe(1_900_000_000_000);
  });

  it('skips windows the bus cannot show', () => {
    const { mapper } = makeMapper();
    expect(
      mapper.translate({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', rateLimitType: 'overage' },
      }),
    ).toStrictEqual([]);
    expect(
      mapper.translate({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
    ).toStrictEqual([]);
  });

  it('records compaction', () => {
    const { mapper, setClock } = makeMapper();
    setClock(4000);
    const events = mapper.translate({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 1234 },
    });
    expect(payloads(events, 'compaction.recorded')).toStrictEqual([
      { sessionId: SID, agentId: SID, at: 4000 },
    ]);
    expect(payloads(events, 'feed.appended')[0]?.items).toStrictEqual([
      {
        kind: 'system',
        text: 'Context compacted (auto, 1234 tokens before)',
        id: `${SID}:1`,
        at: 4000,
      },
    ]);
  });
});
