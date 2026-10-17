import { describe, expect, it, vi } from 'vitest';

import {
  FakeAppServer,
  loadRecording,
  type Recorded,
} from '../../../../test/fake-agents/codex/fake-app-server.js';
import {
  THREAD_ID,
  TURN_ID,
  acceptedApproval,
  crash,
  failedTurn,
  handshake,
  interruptedApproval,
  refusedThread,
  turnCompleted,
  turnStart,
} from '../../../../test/fake-agents/codex/scenarios.js';
import type { AgentEvent } from '../shared/events.js';
import type { AgentRun, StartOptions, ToolPermissionHandler } from '../shared/runtime.js';

import { appServerArgs, codexRuntime, threadRequest } from './runtime.js';

const RECORDED_THREAD = '01a1480b-e3ce-72c0-a983-d84252bd9063';
const RECORDED_TURN_1 = '01a1480b-e400-7c31-8d38-eddcbd29aef2';
const RECORDED_TURN_2 = '01a1480b-f39b-72b0-876e-a00e1cf788bd';

const deny: ToolPermissionHandler = async () => {
  await Promise.resolve();
  return { behavior: 'deny', message: 'no' };
};

const allow: ToolPermissionHandler = async (_name, input) => {
  await Promise.resolve();
  return { behavior: 'allow', updatedInput: input };
};

function options(overrides: Partial<StartOptions> = {}): StartOptions {
  return {
    cwd: '/work/repo',
    sessionId: 'picked-by-overlord',
    resumeId: null,
    fork: false,
    env: { PATH: '/usr/bin' },
    model: null,
    effort: null,
    permissionMode: null,
    extraArgs: {},
    maxBudgetUsd: null,
    executablePath: null,
    noMcp: false,
    canUseTool: deny,
    ...overrides,
  };
}

interface Started {
  readonly run: AgentRun;
  readonly server: FakeAppServer;
  readonly events: AgentEvent[];
  /** Settles with the error the run threw, or null when it ended cleanly. */
  readonly ended: Promise<Error | null>;
}

function start(recording: readonly Recorded[], overrides: Partial<StartOptions> = {}): Started {
  const server = new FakeAppServer(recording);
  const run = codexRuntime(server.spawn).start(options(overrides));
  const events: AgentEvent[] = [];
  const ended = (async (): Promise<Error | null> => {
    try {
      for await (const event of run) {
        events.push(event);
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();
  return { run, server, events, ended };
}

function ofType<T extends AgentEvent['type']>(
  events: readonly AgentEvent[],
  type: T,
): Extract<AgentEvent, { readonly type: T }>[] {
  return events.filter(
    (event): event is Extract<AgentEvent, { readonly type: T }> => event.type === type,
  );
}

async function turnResults(started: Started, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(ofType(started.events, 'turn_result')).toHaveLength(count);
  });
}

describe('the Codex runtime over the recorded app-server exchange', () => {
  it('reports the late thread id, feed, usage and limits, declines and interrupts', async () => {
    const asked: unknown[] = [];
    const started = start(loadRecording(), {
      canUseTool: async (name, input, context) => {
        asked.push({ name, input, toolUseId: context.toolUseId, choices: context.choices });
        await Promise.resolve();
        return { behavior: 'deny', message: 'no' };
      },
    });
    const { run, server, events } = started;
    expect(run.sessionId).toBeNull();
    run.send('Run touch approved.txt');
    await turnResults(started, 1);
    expect(run.sessionId).toBe(RECORDED_THREAD);
    expect(asked).toStrictEqual([
      {
        name: 'exec_command',
        input: { command: 'touch approved.txt', cwd: '/work/repo' },
        toolUseId: 'exec-9959b8d0-b2ce-4976-be20-e57cc35a4027',
        choices: ['allow', 'deny', 'cancel'],
      },
    ]);
    expect(server.replies()).toStrictEqual([{ decision: 'decline' }]);
    expect(events[0]).toStrictEqual({
      type: 'init',
      model: 'gpt-6-luna',
      cwd: '/work/repo',
      tools: [],
      permissionMode: 'untrusted/read-only',
      mcpServers: [],
      version: '0.163.0',
    });
    expect(ofType(events, 'rate_limit')[0]?.windows).toStrictEqual([
      { id: 'primary', usedPct: 0, resetsAt: 1_794_802_006_000, windowMinutes: 43_200 },
    ]);
    expect(ofType(events, 'message').map((event) => [event.messageId, event.blocks])).toStrictEqual(
      [
        [
          `${RECORDED_TURN_1}:1`,
          [
            {
              type: 'tool_use',
              id: 'exec-9959b8d0-b2ce-4976-be20-e57cc35a4027',
              name: 'exec_command',
              input: { command: 'touch approved.txt', cwd: '/work/repo' },
            },
          ],
        ],
        [`${RECORDED_TURN_1}:2`, [{ type: 'text', text: 'declined' }]],
      ],
    );
    expect(ofType(events, 'tool_result')).toStrictEqual([
      {
        type: 'tool_result',
        toolUseId: 'exec-9959b8d0-b2ce-4976-be20-e57cc35a4027',
        ok: false,
        text: 'Declined',
      },
    ]);
    const first = { input: 2286, output: 69, cacheRead: 11_008, cacheCreation: 0, thinking: 0 };
    const second = { input: 352, output: 6, cacheRead: 13_056, cacheCreation: 0, thinking: 0 };
    expect(ofType(events, 'usage').map((event) => [event.messageId, event.usage])).toStrictEqual([
      [`${RECORDED_TURN_1}:1`, first],
      [`${RECORDED_TURN_1}:2`, second],
    ]);
    expect(ofType(events, 'context').at(-1)).toStrictEqual({
      type: 'context',
      usedTokens: 13_414,
      maxTokens: 258_400,
    });
    expect(ofType(events, 'turn_result')[0]).toStrictEqual({
      type: 'turn_result',
      ok: true,
      subtype: 'success',
      text: 'declined',
      costUsd: null,
      turns: null,
      durationMs: 3988,
      usage: { input: 2638, output: 75, cacheRead: 24_064, cacheCreation: 0, thinking: 0 },
    });

    run.send('Write a story');
    await vi.waitFor(() => {
      expect(server.sent('turn/start')).toHaveLength(2);
    });
    await run.interrupt();
    await turnResults(started, 2);
    expect(server.sent('turn/interrupt')).toStrictEqual([
      { threadId: RECORDED_THREAD, turnId: RECORDED_TURN_2 },
    ]);
    expect(ofType(events, 'turn_result')[1]).toMatchObject({ ok: false, subtype: 'interrupted' });
    // The interrupt repeats the last usage report, which is not a new call.
    expect(ofType(events, 'usage')).toHaveLength(2);

    run.endInput();
    expect(await started.ended).toBeNull();
    expect(server.killed).toBe(0);
    expect(server.sent('turn/start')[0]).toStrictEqual({
      threadId: RECORDED_THREAD,
      input: [{ type: 'text', text: 'Run touch approved.txt' }],
    });
  });
});

describe('the Codex runtime over made-up exchanges', () => {
  it('accepts an approval and reports the 5 hour and weekly windows', async () => {
    const started = start(acceptedApproval(), { canUseTool: allow });
    started.run.send('touch it');
    await turnResults(started, 1);
    expect(started.server.replies()).toStrictEqual([{ decision: 'accept' }]);
    expect(ofType(started.events, 'tool_result')).toMatchObject([
      { toolUseId: 'exec-1', ok: true },
    ]);
    expect(ofType(started.events, 'rate_limit').map((event) => event.windows)).toStrictEqual([
      [
        { id: 'primary', usedPct: 12, resetsAt: 1_800_000_000_000, windowMinutes: 300 },
        { id: 'secondary', usedPct: 40, resetsAt: 1_800_500_000_000, windowMinutes: 10_080 },
      ],
      [{ id: 'primary', usedPct: 13, resetsAt: 1_800_000_000_000, windowMinutes: 300 }],
    ]);
    expect(ofType(started.events, 'usage').map((event) => event.usage)).toStrictEqual([
      { input: 490, output: 10, cacheRead: 500, cacheCreation: 0, thinking: 3 },
      { input: 540, output: 10, cacheRead: 550, cacheCreation: 0, thinking: 3 },
    ]);
    started.run.endInput();
    expect(await started.ended).toBeNull();
  });

  it('stops asking the inbox when an interrupt settles the approval', async () => {
    let signal: AbortSignal | null = null;
    const started = start(interruptedApproval(), {
      canUseTool: async (_name, _input, context) => {
        signal = context.signal;
        await new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            reject(new Error('cancelled'));
          });
        });
        return { behavior: 'deny', message: 'never' };
      },
    });
    started.run.send('touch it');
    await vi.waitFor(() => {
      expect(signal).not.toBeNull();
    });
    await started.run.interrupt();
    await turnResults(started, 1);
    expect(signal).toMatchObject({ aborted: true });
    expect(ofType(started.events, 'turn_result')[0]).toMatchObject({
      ok: false,
      subtype: 'interrupted',
    });
    await vi.waitFor(() => {
      expect(started.server.replies()).toStrictEqual([{ decision: 'decline' }]);
    });
    started.run.stop();
    expect(await started.ended).toBeNull();
    expect(started.server.killed).toBe(1);
  });

  it('notes a retry and fails the turn with the error', async () => {
    const started = start(failedTurn());
    started.run.send('go');
    await turnResults(started, 1);
    expect(ofType(started.events, 'notice')).toStrictEqual([
      { type: 'notice', text: 'Codex is retrying: stream lost' },
    ]);
    expect(ofType(started.events, 'turn_result')[0]).toMatchObject({
      ok: false,
      subtype: 'error',
      text: 'usage limit hit',
    });
    started.run.endInput();
    expect(await started.ended).toBeNull();
  });

  it('fails the run with stderr when the server dies', async () => {
    const started = start(crash());
    started.run.send('go');
    const error = await started.ended;
    expect(error?.message).toBe('codex app-server exited with code 1: panic: boom');
  });

  it('fails before naming a session when thread/start is refused', async () => {
    const started = start(refusedThread());
    started.run.send('go');
    const error = await started.ended;
    expect(error?.message).toBe('thread/start: cwd does not exist');
    expect(started.run.sessionId).toBeNull();
  });

  it('answers a request it does not handle with an error', async () => {
    const started = start([
      ...handshake(),
      ...turnStart(),
      { dir: 'recv', msg: { id: 7, method: 'item/tool/requestUserInput', params: {} } },
      turnCompleted(TURN_ID, 'completed'),
    ]);
    started.run.send('go');
    await turnResults(started, 1);
    await vi.waitFor(() => {
      expect(started.server.replies()).toStrictEqual([
        { code: -32_601, message: 'Overlord does not answer item/tool/requestUserInput' },
      ]);
    });
    started.run.endInput();
    expect(await started.ended).toBeNull();
  });

  it('carries a new model and mode into the next turn only', async () => {
    const started = start([
      ...handshake(),
      ...turnStart(),
      turnCompleted(TURN_ID, 'completed'),
      ...turnStart('turn-2'),
      turnCompleted('turn-2', 'completed'),
    ]);
    await vi.waitFor(() => {
      expect(started.run.sessionId).toBe(THREAD_ID);
    });
    await started.run.setModel?.('gpt-6');
    await started.run.setPermissionMode?.('never/read-only');
    started.run.send('one');
    await turnResults(started, 1);
    started.run.send('two');
    await turnResults(started, 2);
    expect(started.server.sent('turn/start')).toStrictEqual([
      {
        threadId: THREAD_ID,
        input: [{ type: 'text', text: 'one' }],
        model: 'gpt-6',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      },
      { threadId: THREAD_ID, input: [{ type: 'text', text: 'two' }] },
    ]);
    await expect(started.run.setPermissionMode?.('ask/everything')).rejects.toThrow(
      'Unknown permission mode "ask/everything"',
    );
    started.run.stop();
    expect(await started.ended).toBeNull();
  });

  it('resumes and forks through their own requests', async () => {
    const resumed = start(handshake('thread/resume'), { resumeId: THREAD_ID });
    await vi.waitFor(() => {
      expect(resumed.run.sessionId).toBe(THREAD_ID);
    });
    expect(resumed.server.sent('thread/resume')).toStrictEqual([
      { threadId: THREAD_ID, excludeTurns: true, cwd: '/work/repo' },
    ]);
    resumed.run.endInput();
    expect(await resumed.ended).toBeNull();

    const forked = start(handshake('thread/fork', 'forked-thread'), {
      resumeId: THREAD_ID,
      fork: true,
    });
    await vi.waitFor(() => {
      expect(forked.run.sessionId).toBe('forked-thread');
    });
    forked.run.stop();
    expect(await forked.ended).toBeNull();
  });
});

describe('how the Codex runtime starts app-server', () => {
  it('passes effort as -c and the profile flags as they are', () => {
    const started = start(handshake(), {
      effort: 'high',
      extraArgs: { config: 'web_search="live"', 'strict-config': null },
      model: 'gpt-6-luna',
      permissionMode: 'on-request/workspace-write',
      executablePath: '/opt/codex',
    });
    expect(started.server.launches).toStrictEqual([
      {
        command: '/opt/codex',
        args: [
          'app-server',
          '-c',
          'model_reasoning_effort="high"',
          '--config',
          'web_search="live"',
          '--strict-config',
        ],
        cwd: '/work/repo',
        env: { PATH: '/usr/bin' },
      },
    ]);
    started.run.stop();
    expect(appServerArgs(options())).toStrictEqual(['app-server']);
    expect(
      threadRequest(options({ model: 'gpt-6-luna', permissionMode: 'on-request/workspace-write' })),
    ).toStrictEqual({
      method: 'thread/start',
      params: {
        cwd: '/work/repo',
        model: 'gpt-6-luna',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      },
    });
  });

  it('refuses a mode Codex does not have before it starts anything', () => {
    const server = new FakeAppServer([]);
    expect(() => codexRuntime(server.spawn).start(options({ permissionMode: 'plan' }))).toThrow(
      'Unknown permission mode "plan"',
    );
    expect(server.launches).toStrictEqual([]);
  });
});
