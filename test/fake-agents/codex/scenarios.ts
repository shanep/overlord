// Made-up app-server exchanges for what the recording does not show: an
// approval accepted, an interrupt while an approval waits, a failed turn and
// a server that dies. They use the shapes of the 0.163.0 recording.

import type { Message, Recorded } from './fake-app-server.js';

export const THREAD_ID = '01a1480b-0000-7000-8000-000000000001';
export const TURN_ID = '01a1480b-0000-7000-8000-0000000000a1';

function send(message: Message): Recorded {
  return { dir: 'send', msg: message };
}

function recv(message: Message): Recorded {
  return { dir: 'recv', msg: message };
}

function notice(method: string, params: Message): Recorded {
  return recv({ method, params: { threadId: THREAD_ID, ...params }, emittedAtMs: 1 });
}

/** initialize, initialized, thread/start and a rate limit read. */
export function handshake(method = 'thread/start', threadId = THREAD_ID): Recorded[] {
  return [
    send({ id: 1, method: 'initialize' }),
    recv({ id: 1, result: { userAgent: 'fake/0.163.0', platformOs: 'macos' } }),
    send({ method: 'initialized' }),
    send({ id: 2, method }),
    recv({
      id: 2,
      result: {
        thread: { id: threadId, cliVersion: '0.163.0', path: '/home/user/.codex/x.jsonl' },
        model: 'gpt-6-luna',
        cwd: '/work/repo',
        approvalPolicy: 'on-request',
        sandbox: { type: 'workspaceWrite', networkAccess: false },
      },
    }),
    send({ id: 3, method: 'account/rateLimits/read' }),
    recv({
      id: 3,
      result: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
        },
      },
    }),
  ];
}

export function turnStart(turnId = TURN_ID): Recorded[] {
  return [
    send({ id: 4, method: 'turn/start' }),
    recv({ id: 4, result: { turn: { id: turnId, status: 'inProgress', items: [] } } }),
    notice('turn/started', { turn: { id: turnId, status: 'inProgress', items: [] } }),
  ];
}

function commandItem(status: string, output: string | null, exitCode: number | null): Message {
  return {
    type: 'commandExecution',
    id: 'exec-1',
    command: "/bin/zsh -lc 'touch approved.txt'",
    cwd: '/work/repo',
    status,
    aggregatedOutput: output,
    exitCode,
  };
}

/** The command starts and asks for approval as server request 0. */
function commandApproval(turnId = TURN_ID): Recorded[] {
  return [
    notice('item/started', { turnId, item: commandItem('inProgress', null, null) }),
    recv({
      id: 0,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: THREAD_ID,
        turnId,
        itemId: 'exec-1',
        command: "/bin/zsh -lc 'touch approved.txt'",
        cwd: '/work/repo',
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      },
    }),
  ];
}

/** A usage breakdown where half the input was cached. */
function breakdown(tokens: number): Message {
  return {
    totalTokens: tokens,
    inputTokens: tokens - 10,
    cachedInputTokens: Math.floor(tokens / 2),
    cacheWriteInputTokens: 0,
    outputTokens: 10,
    reasoningOutputTokens: 3,
  };
}

function usage(turnId: string, total: number, last: number): Recorded {
  return notice('thread/tokenUsage/updated', {
    turnId,
    tokenUsage: { total: breakdown(total), last: breakdown(last), modelContextWindow: 258_400 },
  });
}

export function turnCompleted(
  turnId: string,
  status: string,
  error: string | null = null,
): Recorded {
  return notice('turn/completed', {
    turn: {
      id: turnId,
      status,
      items: [],
      error: error === null ? null : { message: error },
      durationMs: 1200,
    },
  });
}

/** An approval the client accepts, then the command runs and the model answers. */
export function acceptedApproval(): Recorded[] {
  return [
    ...handshake(),
    ...turnStart(),
    ...commandApproval(),
    send({ id: 0, result: { decision: 'accept' } }),
    notice('serverRequest/resolved', { requestId: 0 }),
    notice('item/completed', { turnId: TURN_ID, item: commandItem('completed', '', 0) }),
    usage(TURN_ID, 1000, 1000),
    recv({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 13, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: null,
        },
      },
    }),
    notice('item/completed', {
      turnId: TURN_ID,
      item: { type: 'agentMessage', id: 'msg-1', text: 'done', phase: 'final_answer' },
    }),
    usage(TURN_ID, 2100, 1100),
    turnCompleted(TURN_ID, 'completed'),
  ];
}

/** An interrupt while an approval waits: the server settles the request and ends the turn. */
export function interruptedApproval(): Recorded[] {
  return [
    ...handshake(),
    ...turnStart(),
    ...commandApproval(),
    send({ id: 5, method: 'turn/interrupt' }),
    notice('serverRequest/resolved', { requestId: 0 }),
    notice('item/completed', { turnId: TURN_ID, item: commandItem('declined', null, null) }),
    recv({ id: 5, result: {} }),
    turnCompleted(TURN_ID, 'interrupted'),
  ];
}

/** A retry notice, then a turn that fails. */
export function failedTurn(): Recorded[] {
  return [
    ...handshake(),
    ...turnStart(),
    notice('error', { turnId: TURN_ID, error: { message: 'stream lost' }, willRetry: true }),
    notice('error', { turnId: TURN_ID, error: { message: 'usage limit hit' }, willRetry: false }),
    turnCompleted(TURN_ID, 'failed', 'usage limit hit'),
  ];
}

/** The server dies mid turn. */
export function crash(): Recorded[] {
  return [...handshake(), ...turnStart(), { dir: 'exit', code: 1, stderr: 'panic: boom\n' }];
}

/** thread/start fails, as it does for a cwd Codex cannot use. */
export function refusedThread(): Recorded[] {
  return [
    send({ id: 1, method: 'initialize' }),
    recv({ id: 1, result: {} }),
    send({ method: 'initialized' }),
    send({ id: 2, method: 'thread/start' }),
    recv({ id: 2, error: { code: -32_600, message: 'cwd does not exist' } }),
  ];
}
