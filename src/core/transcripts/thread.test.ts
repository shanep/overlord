import { describe, expect, it } from 'vitest';

import type { PriceTable } from './pricing.js';
import type { TranscriptRecord } from './schemas.js';
import { parseTranscriptLine } from './schemas.js';
import {
  assistant,
  attachment,
  iso,
  system,
  T0,
  text,
  thinking,
  toolResult,
  toolUse,
  usage,
  userPrompt,
} from './test-helpers/fixtures.js';
import type { ThreadOptions } from './thread.js';
import { AgentThread } from './thread.js';

const PRICES: PriceTable = {
  'claude-opus-5-5': { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
};

function record(fields: unknown): TranscriptRecord {
  const parsed = parseTranscriptLine(JSON.stringify(fields));
  if (parsed === null) {
    throw new Error('fixture did not parse');
  }
  return parsed;
}

function note(id: string, status: string): string {
  return `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>`;
}

function makeThread(overrides: Partial<ThreadOptions> = {}): AgentThread {
  return new AgentThread({
    sessionId: 's1',
    agentId: 'main',
    prices: PRICES,
    feedLimit: 100,
    previewChars: 10,
    ...overrides,
  });
}

function feed(thread: AgentThread, ...records: readonly unknown[]): AgentThread {
  for (const fields of records) {
    thread.ingest(record(fields));
  }
  return thread;
}

describe('AgentThread', () => {
  it('starts with no activity', () => {
    const thread = makeThread();
    expect(thread.agentId).toBe('main');
    expect(thread.state(T0, 1000)).toBe('unknown');
    expect(thread.usage()).toStrictEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      thinking: 0,
    });
    expect(thread.toolCalls()).toStrictEqual([]);
    expect(thread.requests()).toStrictEqual([]);
    expect(thread.feed(10)).toStrictEqual([]);
    expect(thread.compactions()).toStrictEqual([]);
    expect(thread.currentTool()).toBeNull();
    expect(thread.firstAt).toBeNull();
    expect(thread.lastAt).toBeNull();
    expect(thread.model).toBeNull();
    expect(thread.effort).toBeNull();
    expect(thread.firstPrompt).toBeNull();
  });

  it('tracks first and last activity, ignoring an out of order earlier time', () => {
    const thread = feed(
      makeThread(),
      userPrompt('u1', 100, 'a'),
      userPrompt('u2', 300, 'b'),
      userPrompt('u3', 200, 'c'),
    );
    expect(thread.firstAt).toBe(T0 + 100);
    expect(thread.lastAt).toBe(T0 + 300);
    expect(thread.firstPrompt).toBe('a');
  });

  it('turns prompts into user feed items and opens the turn', () => {
    const thread = makeThread();
    const delta = thread.ingest(record(userPrompt('u1', 0, 'do it')));
    expect(delta.feed).toStrictEqual([{ kind: 'user', id: 'u1', at: T0, text: 'do it' }]);
    expect(delta.tools).toStrictEqual([]);
    expect(delta.requests).toStrictEqual([]);
    expect(delta.compactions).toStrictEqual([]);
    expect(delta.contextChanged).toBe(false);
    expect(thread.state(T0 + 1000, 1000)).toBe('running');
    expect(thread.state(T0 + 1001, 1000)).toBe('idle');
  });

  it('marks meta and compact summary prompts as system items without opening the turn', () => {
    const thread = feed(
      makeThread(),
      userPrompt('u1', 0, 'skill body', { isMeta: true }),
      userPrompt('u2', 1, 'summary', { isCompactSummary: true }),
    );
    expect(thread.feed(10)).toStrictEqual([
      { kind: 'system', id: 'u1', at: T0, text: 'skill body' },
      { kind: 'system', id: 'u2', at: T0 + 1, text: 'summary' },
    ]);
    expect(thread.state(T0 + 1, 1000)).toBe('idle');
    expect(thread.firstPrompt).toBeNull();
  });

  it('handles text blocks in user content and records without uuid or time', () => {
    const thread = makeThread();
    const fields = {
      type: 'user',
      message: { content: [{ type: 'text', text: 'block prompt' }, { type: 'image' }] },
    };
    const delta = thread.ingest(record(fields));
    expect(delta.feed).toStrictEqual([
      { kind: 'user', id: 'user-0:0', at: 0, text: 'block prompt' },
    ]);
    const second = thread.ingest(record({ type: 'user', message: { content: 'again' } }));
    expect(second.feed[0]?.id).toBe('user-1');
    expect(thread.lastAt).toBeNull();
  });

  it('records tool calls, their results and the current tool', () => {
    const thread = makeThread();
    const call = thread.ingest(
      record(
        assistant({
          uuid: 'a1',
          at: 10,
          messageId: 'm1',
          stop: 'tool_use',
          content: [toolUse('t1', 'Bash', { command: 'ls' })],
        }),
      ),
    );
    thread.ingest(
      record(
        assistant({
          uuid: 'a2',
          at: 11,
          messageId: 'm1',
          stop: 'tool_use',
          content: [toolUse('t2', 'Read')],
        }),
      ),
    );
    expect(call.tools).toStrictEqual([
      {
        id: 't1',
        sessionId: 's1',
        agentId: 'main',
        name: 'Bash',
        input: { command: 'ls' },
        startedAt: T0 + 10,
        endedAt: null,
        ok: null,
        resultPreview: null,
      },
    ]);
    expect(call.feed).toStrictEqual([
      { kind: 'tool_use', id: 'a1:0', at: T0 + 10, name: 'Bash', input: { command: 'ls' } },
    ]);
    expect(thread.currentTool()).toBe('Read');
    expect(thread.hasToolUse('t1')).toBe(true);
    expect(thread.hasToolUse('nope')).toBe(false);

    const result = thread.ingest(
      record(toolResult('u1', 20, [{ toolUseId: 't2', text: '0123456789abc', isError: true }])),
    );
    expect(result.tools).toStrictEqual([
      {
        id: 't2',
        sessionId: 's1',
        agentId: 'main',
        name: 'Read',
        input: {},
        startedAt: T0 + 11,
        endedAt: T0 + 20,
        ok: false,
        resultPreview: '0123456789...',
      },
    ]);
    expect(result.feed).toStrictEqual([
      {
        kind: 'tool_result',
        id: 'u1:0',
        at: T0 + 20,
        toolUseId: 't2',
        ok: false,
        text: '0123456789...',
      },
    ]);
    expect(thread.currentTool()).toBe('Bash');
    expect(thread.outcome('t2')).toStrictEqual({ at: T0 + 20, ok: false, async: false });
    expect(thread.outcome('t1')).toBeNull();
    expect(thread.state(T0 + 20, 1000)).toBe('running');

    thread.ingest(record(toolResult('u2', 30, [{ toolUseId: 't1' }])));
    expect(thread.currentTool()).toBeNull();
    expect(thread.toolCalls().map((tool) => [tool.id, tool.ok])).toStrictEqual([
      ['t1', true],
      ['t2', false],
    ]);
  });

  it('uses time zero for a tool result without a timestamp', () => {
    const thread = makeThread();
    thread.ingest(
      record(
        assistant({
          uuid: 'a',
          at: 1,
          messageId: 'm',
          stop: 'tool_use',
          content: [toolUse('t', 'Bash')],
        }),
      ),
    );
    thread.ingest(
      record({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
      }),
    );
    expect(thread.toolCalls()[0]).toMatchObject({ endedAt: 0, ok: true, resultPreview: 'x' });
    expect(thread.outcome('t')).toStrictEqual({ at: 0, ok: true, async: false });
  });

  it('stays running while a tool waits for its result after the turn closes', () => {
    const thread = makeThread();
    thread.ingest(
      record(
        assistant({
          uuid: 'a',
          at: 1,
          messageId: 'm',
          stop: 'tool_use',
          content: [toolUse('t', 'Bash')],
        }),
      ),
    );
    thread.ingest(record(system('s', 2, { subtype: 'turn_duration', durationMs: 1 })));
    expect(thread.state(T0 + 2, 10)).toBe('running');
    thread.ingest(record(toolResult('u', 3, [{ toolUseId: 't' }])));
    expect(thread.state(T0 + 3, 10)).toBe('idle');
  });

  it('keeps an outcome for results whose tool use it never saw', () => {
    const thread = makeThread();
    const delta = thread.ingest(
      record(
        toolResult('u1', 5, [{ toolUseId: 'ghost' }], {
          toolUseResult: { status: 'async_launched' },
        }),
      ),
    );
    expect(delta.tools).toStrictEqual([]);
    expect(delta.feed).toHaveLength(1);
    expect(thread.outcome('ghost')).toStrictEqual({ at: T0 + 5, ok: true, async: true });
  });

  it('dedupes requests by message id, keeping the last usage and the first time', () => {
    const thread = makeThread();
    thread.ingest(
      record(
        assistant({
          uuid: 'a1',
          at: 1,
          messageId: 'm1',
          stop: null,
          usage: usage({ input: 1_000_000, output: 1 }),
          content: [thinking('plan')],
        }),
      ),
    );
    const second = thread.ingest(
      record(
        assistant({
          uuid: 'a2',
          at: 2,
          messageId: 'm1',
          usage: usage({
            input: 1_000_000,
            output: 1_000_000,
            cacheRead: 1_000_000,
            cacheCreation: 1_000_000,
            thinking: 7,
          }),
          content: [text('answer')],
        }),
      ),
    );
    expect(second.requests).toStrictEqual([
      {
        messageId: 'm1',
        requestId: 'req-m1',
        sessionId: 's1',
        agentId: 'main',
        model: 'claude-opus-5-5',
        timestamp: T0 + 1,
        usage: {
          input: 1_000_000,
          output: 1_000_000,
          cacheRead: 1_000_000,
          cacheCreation: 1_000_000,
          thinking: 7,
        },
        ttftMs: null,
        durationMs: null,
        costUsd: 10,
      },
    ]);
    expect(thread.requests()).toHaveLength(1);
    expect(thread.usage().output).toBe(1_000_000);
    expect(thread.model).toBe('claude-opus-5-5');
    expect(thread.effort).toBe('high');
    expect(thread.feed(10).map((item) => item.kind)).toStrictEqual(['thinking', 'text']);
    expect(thread.state(T0 + 2, 1000)).toBe('idle');
  });

  it('keeps earlier usage and request id when a later record lacks them', () => {
    const thread = makeThread();
    thread.ingest(
      record(
        assistant({ uuid: 'a1', at: 1, messageId: 'm1', usage: usage({ input: 5 }), content: [] }),
      ),
    );
    const fields = assistant({
      uuid: 'a2',
      at: 2,
      messageId: 'm1',
      usage: null,
      content: [],
      extra: { requestId: null, effort: null },
    });
    thread.ingest(record(fields));
    expect(thread.requests()[0]?.usage.input).toBe(5);
    expect(thread.requests()[0]?.requestId).toBe('req-m1');
    expect(thread.effort).toBe('high');
    const fresh = makeThread();
    fresh.ingest(record(fields));
    expect(fresh.requests()[0]?.usage).toStrictEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      thinking: 0,
    });
    expect(fresh.requests()[0]?.requestId).toBeNull();
    expect(fresh.effort).toBeNull();
  });

  it('gives unknown models a null cost', () => {
    const thread = feed(
      makeThread(),
      assistant({ uuid: 'a1', at: 1, messageId: 'm1', model: 'claude-mystery', content: [] }),
    );
    expect(thread.requests()[0]?.costUsd).toBeNull();
  });

  it('skips synthetic messages for requests and model but keeps their text', () => {
    const thread = feed(
      makeThread(),
      assistant({
        uuid: 'a1',
        at: 1,
        messageId: 'm1',
        model: '<synthetic>',
        content: [text('API Error')],
      }),
    );
    expect(thread.requests()).toStrictEqual([]);
    expect(thread.model).toBeNull();
    expect(thread.feed(5)).toStrictEqual([
      { kind: 'text', id: 'a1:0', at: T0 + 1, text: 'API Error' },
    ]);
  });

  it('skips empty text and thinking blocks and uses the message id without a uuid', () => {
    const thread = makeThread();
    const delta = thread.ingest(
      record({
        type: 'assistant',
        message: {
          id: 'm9',
          model: 'claude-opus-5-5',
          content: [text(''), thinking(''), text('x')],
        },
      }),
    );
    expect(delta.feed).toStrictEqual([{ kind: 'text', id: 'm9:2', at: 0, text: 'x' }]);
  });

  it('opens the turn for tool use, pause and streaming stops and closes it otherwise', () => {
    const thread = makeThread();
    const at = (stop: string | null, offset: number): void => {
      thread.ingest(
        record(
          assistant({
            uuid: `a${String(offset)}`,
            at: offset,
            messageId: `m${String(offset)}`,
            stop,
            content: [],
          }),
        ),
      );
    };
    at('pause_turn', 1);
    expect(thread.state(T0 + 1, 10)).toBe('running');
    at('end_turn', 2);
    expect(thread.state(T0 + 2, 10)).toBe('idle');
    at(null, 3);
    expect(thread.state(T0 + 3, 10)).toBe('running');
    at('max_tokens', 4);
    expect(thread.state(T0 + 4, 10)).toBe('idle');
    at('tool_use', 5);
    expect(thread.state(T0 + 5, 10)).toBe('running');
    thread.ingest(record(system('s1', 6, { subtype: 'turn_duration', durationMs: 5 })));
    expect(thread.state(T0 + 6, 10)).toBe('idle');
    expect(thread.feed(100)).toStrictEqual([]);
  });

  it('records compactions and system text', () => {
    const thread = makeThread();
    const delta = thread.ingest(
      record(system('s1', 7, { subtype: 'compact_boundary', content: 'Conversation compacted' })),
    );
    expect(delta.compactions).toStrictEqual([T0 + 7]);
    expect(delta.feed).toStrictEqual([
      { kind: 'system', id: 's1', at: T0 + 7, text: 'Conversation compacted' },
    ]);
    thread.ingest(
      record(system('s2', 8, { subtype: 'away_summary', content: 'While you were away' })),
    );
    thread.ingest(record(system('s3', 9, { subtype: 'informational' })));
    thread.ingest(record({ type: 'system', subtype: 'compact_boundary' }));
    expect(thread.compactions()).toStrictEqual([T0 + 7, 0]);
    expect(thread.feed(10)).toStrictEqual([
      { kind: 'system', id: 's1', at: T0 + 7, text: 'Conversation compacted' },
      { kind: 'system', id: 's2', at: T0 + 8, text: 'While you were away' },
      { kind: 'system', id: 'system-2', at: 0, text: 'Conversation compacted' },
    ]);
  });

  it('records task notifications from user text and queued commands', () => {
    const thread = makeThread();
    const delta = thread.ingest(record(userPrompt('u1', 3, note('t1', 'completed'))));
    expect(delta.feed).toStrictEqual([
      { kind: 'system', id: 'u1', at: T0 + 3, text: note('t1', 'completed') },
    ]);
    expect(thread.notification('t1')).toStrictEqual({ at: T0 + 3, status: 'completed' });
    const queued = thread.ingest(
      record(attachment('q1', 4, { type: 'queued_command', prompt: note('t2', 'failed') })),
    );
    expect(queued.contextChanged).toBe(false);
    expect(thread.notification('t2')).toStrictEqual({ at: T0 + 4, status: 'failed' });
    thread.ingest(
      record({
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: note('t3', 'killed') },
      }),
    );
    expect(thread.notification('t3')).toStrictEqual({ at: 0, status: 'killed' });
    thread.ingest(record(attachment('q2', 5, { type: 'queued_command', prompt: 'just a prompt' })));
    expect(thread.notification('nope')).toBeNull();
    thread.ingest(record(userPrompt('u2', 6, '<task-notification>broken')));
    expect(thread.state(T0 + 6, 100)).toBe('idle');
  });

  it('applies context attachments with their time', () => {
    const thread = makeThread();
    const delta = thread.ingest(
      record(attachment('c1', 9, { type: 'prompt_snapshot', systemPrompt: ['p'] })),
    );
    expect(delta.contextChanged).toBe(true);
    expect(thread.context.snapshot({ sessionId: 's1', agentId: 'main' }, null)).toMatchObject({
      at: T0 + 9,
      systemPrompt: ['p'],
    });
    expect(thread.lastAt).toBe(T0 + 9);
  });

  it('ignores session marker records', () => {
    const thread = makeThread();
    for (const fields of [
      { type: 'ai-title', aiTitle: 't' },
      { type: 'custom-title', customTitle: 't' },
      { type: 'last-prompt', lastPrompt: 'p' },
      { type: 'permission-mode', permissionMode: 'plan' },
    ]) {
      const delta = thread.ingest(record(fields));
      expect(delta.feed).toStrictEqual([]);
    }
    expect(thread.lastAt).toBeNull();
  });

  it('caps the feed and returns the newest items', () => {
    const thread = makeThread({ feedLimit: 3 });
    for (let index = 0; index < 5; index += 1) {
      thread.ingest(record(userPrompt(`u${String(index)}`, index, `p${String(index)}`)));
    }
    expect(thread.feed(10).map((item) => item.id)).toStrictEqual(['u2', 'u3', 'u4']);
    expect(thread.feed(2).map((item) => item.id)).toStrictEqual(['u3', 'u4']);
    expect(thread.feed(0)).toStrictEqual([]);
    expect(thread.feed(-1)).toStrictEqual([]);
  });

  it('returns copies of compaction times', () => {
    const thread = feed(makeThread(), system('s1', 1, { subtype: 'compact_boundary' }));
    thread.compactions().push(99);
    expect(thread.compactions()).toStrictEqual([T0 + 1]);
  });

  it('parses the fixture timestamp helper', () => {
    expect(Date.parse(iso(0))).toBe(T0);
  });
});
