// Synthetic transcript lines shaped like Claude Code's. No real message text.
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../../shared/protocol.js';

import type { FileContext } from './extract.js';
import { BROADCAST, extractMessages, MAIN } from './extract.js';
import { textKey } from './text.js';

const T0 = '2026-01-02T03:04:05.000Z';
const AT = Date.parse(T0);
const MAIN_FILE: FileContext = { sessionId: 's1', owner: MAIN, parent: MAIN };
const SUB_FILE: FileContext = { sessionId: 's1', owner: 'a111', parent: 'a000' };

function send(id: string, input: unknown, uuid: string | null = `u-${id}`): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: T0,
    message: {
      content: [
        { type: 'text', text: 'sending' },
        { type: 'tool_use', id, name: 'SendMessage', input },
      ],
    },
  });
}

function result(toolUseId: string, content: unknown, isError: boolean | null): string {
  return JSON.stringify({
    type: 'user',
    uuid: `r-${toolUseId}`,
    timestamp: T0,
    message: {
      content: [
        { type: 'text', text: 'x' },
        { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content },
      ],
    },
  });
}

function delivered(uuid: string | null, origin: unknown, content: unknown): string {
  return JSON.stringify({ type: 'user', uuid, timestamp: T0, origin, message: { content } });
}

function queued(uuid: string, origin: unknown, prompt: string): string {
  return JSON.stringify({
    type: 'attachment',
    uuid,
    timestamp: T0,
    attachment: { type: 'queued_command', prompt, origin },
  });
}

function only(lines: readonly string[], context: FileContext = MAIN_FILE): AgentMessage {
  const found = extractMessages(lines, context);
  expect(found).toHaveLength(1);
  const [first] = found;
  if (first === undefined) {
    throw new Error('no message');
  }
  return first.message;
}

describe('sends', () => {
  it('reads a SendMessage call with its summary as the preview', () => {
    const found = extractMessages(
      [send('t1', { to: 'helper', message: 'Please check   the build', summary: 'Check build' })],
      MAIN_FILE,
    );
    expect(found).toStrictEqual([
      {
        message: {
          id: 's1:t1',
          at: AT,
          sessionId: 's1',
          from: MAIN,
          to: 'helper',
          kind: 'send',
          preview: 'Check build',
          blocked: false,
        },
        textKey: textKey('Please check the build'),
      },
    ]);
  });

  it('falls back to the message text, and names structured messages by type', () => {
    expect(only([send('t1', { to: 'x', message: 'plain text', summary: '  ' })]).preview).toBe(
      'plain text',
    );
    expect(only([send('t1', { to: 'x', message: 'plain', summary: null })]).preview).toBe('plain');
    expect(only([send('t1', { to: 'x', message: { type: 'shutdown_request' } })]).preview).toBe(
      'shutdown_request',
    );
    expect(only([send('t1', { to: 'x', message: { reason: 1 } })]).preview).toBe('message');
  });

  it('marks a send to everyone as a broadcast, from the subagent that made it', () => {
    const message = only([send('t2', { to: BROADCAST, message: 'all hands' })], SUB_FILE);
    expect(message).toMatchObject({ kind: 'broadcast', from: 'a111', to: '*' });
  });

  it('skips calls without a recipient and other tools', () => {
    const other = JSON.stringify({
      type: 'assistant',
      timestamp: T0,
      message: {
        content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { to: 'SendMessage' } }],
      },
    });
    expect(extractMessages([send('t3', { message: 'no to' }), other], MAIN_FILE)).toStrictEqual([]);
  });

  it('marks a send blocked when its result says a hook or rule denied it', () => {
    const lines = [
      send('a', { to: 'uds:/tmp/1.sock', message: 'one' }),
      send('b', { to: 'peer', message: 'two' }),
      send('c', { to: 'peer', message: 'three' }),
      send('d', { to: 'peer', message: 'four' }),
      send('e', { to: 'peer', message: 'five' }),
      result('a', 'Denied by Overlord auto-approve rule r1', true),
      result('b', [{ type: 'text', text: 'PreToolUse:SendMessage hook error: no' }], true),
      result('c', 'Not sent: the session is offline', true),
      result('d', 'Permission denied', false),
      result('e', [{ type: 'image' }, { type: 'text', text: 'blocked' }], true),
      result('zzz', 'denied', true),
    ];
    expect(
      extractMessages(lines, MAIN_FILE).map((entry) => [entry.message.id, entry.message.blocked]),
    ).toStrictEqual([
      ['s1:a', true],
      ['s1:b', true],
      ['s1:c', false],
      ['s1:d', false],
      ['s1:e', true],
    ]);
  });

  it('does not read a word inside another word as a denial', () => {
    const lines = [send('a', { to: 'p', message: 'm' }), result('a', 'undeniable hooked', true)];
    expect(only(lines).blocked).toBe(false);
  });
});

describe('deliveries', () => {
  const report = '[Subagent hand-back] Header words. The report follows:\n  All done.';

  it('reads a hand-back from a subagent', () => {
    const origin = { kind: 'peer', from: 'a222', senderTaskId: 'a222', handback: true };
    const text = `Another Claude session sent a message:\n<agent-message from="a222">\n${report}\n</agent-message>`;
    expect(only([delivered('u1', { ...origin, body: report }, text)])).toStrictEqual({
      id: 's1:u1',
      at: AT,
      sessionId: 's1',
      from: 'a222',
      to: MAIN,
      kind: 'hand-back',
      preview: 'All done.',
      blocked: false,
    });
    expect(only([delivered('u1', origin, text)]).preview).toBe('All done.');
    expect(
      only([delivered('u1', { ...origin, handbackReportText: 'Short report' }, text)]).preview,
    ).toBe('Short report');
  });

  it('names a session peer by its session name and an agent peer by its id', () => {
    const session = { kind: 'peer', from: 'uds:/tmp/2.sock', name: 'api-worker', body: 'ready' };
    expect(only([queued('q1', session, '<cross-session-message>ready')])).toMatchObject({
      id: 's1:q1',
      from: 'api-worker',
      to: MAIN,
      kind: 'receive',
      preview: 'ready',
    });
    expect(only([queued('q1', { ...session, name: null }, 'x')]).from).toBe('uds:/tmp/2.sock');
    const agent = { kind: 'peer', from: 'a333', senderTaskId: 'a333', name: 'Explore' };
    expect(only([queued('q2', agent, 'hi')]).from).toBe('a333');
    expect(only([queued('q3', { kind: 'peer', name: 'n' }, 'hi')]).from).toBe('unknown');
  });

  it('reads a message from the launching agent in a subagent file', () => {
    const text = 'The coordinator sent a message while you were working:\nAlso fix the tests';
    const message = only([delivered('u2', { kind: 'coordinator' }, text)], SUB_FILE);
    expect(message).toMatchObject({
      from: 'a000',
      to: 'a111',
      kind: 'receive',
      preview: 'Also fix the tests',
    });
    expect(only([queued('q4', { kind: 'coordinator' }, 'Next step')], SUB_FILE).from).toBe('a000');
  });

  it('reads agent task notifications and skips shell and monitor ones', () => {
    const agentDone =
      '<task-notification>\n<task-id>a444</task-id>\n<status>completed</status>\n<summary>Agent &quot;Audit&quot; completed</summary>\n</task-notification>';
    const origin = { kind: 'task-notification' };
    expect(only([delivered('u3', origin, agentDone)])).toMatchObject({
      from: 'a444',
      to: MAIN,
      kind: 'task-notification',
      preview: 'Agent "Audit" completed',
    });
    const shell = '<task-id>b1</task-id><summary>Background command "x" completed</summary>';
    const noId = '<summary>Agent "y" completed</summary>';
    const noSummary = '<task-id>a5</task-id>';
    expect(
      extractMessages(
        [queued('q5', origin, shell), queued('q6', origin, noId), queued('q7', origin, noSummary)],
        MAIN_FILE,
      ),
    ).toStrictEqual([]);
  });

  it('reads the text blocks of a list content', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'image' },
      { type: 'text', text: 'second' },
    ];
    expect(only([delivered('u4', { kind: 'peer', from: 'p' }, content)]).preview).toBe(
      'first second',
    );
  });

  it('skips prompts the user typed and records with no origin', () => {
    expect(
      extractMessages(
        [
          delivered('u5', { kind: 'human' }, 'a prompt with "origin" in it'),
          delivered('u6', null, '<agent-message from="a1">quoted</agent-message> "origin"'),
        ],
        MAIN_FILE,
      ),
    ).toStrictEqual([]);
  });
});

describe('ids and lines', () => {
  it('uses the line number when a record has no uuid, and 0 when it has no time', () => {
    const noTime = JSON.stringify({
      type: 'user',
      origin: { kind: 'peer', from: 'p' },
      message: { content: 'x' },
    });
    const found = extractMessages(
      ['', 'not json "origin"', delivered(null, { kind: 'peer', from: 'p' }, 'x'), noTime],
      SUB_FILE,
    );
    expect(found.map((entry) => [entry.message.id, entry.message.at])).toStrictEqual([
      ['s1:a111:3', AT],
      ['s1:a111:4', 0],
    ]);
  });

  it('gives the same messages on every read of the same lines', () => {
    const lines = [send('t9', { to: 'x', message: 'm' }), queued('q9', { kind: 'peer' }, 'y')];
    expect(extractMessages(lines, MAIN_FILE)).toStrictEqual(extractMessages(lines, MAIN_FILE));
  });
});
