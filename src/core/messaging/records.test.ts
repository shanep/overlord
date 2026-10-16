import { describe, expect, it } from 'vitest';

import { mayHoldMessage, parseMessageRecord } from './records.js';

describe('mayHoldMessage', () => {
  it('passes lines with a send, an origin or a tool result', () => {
    expect(mayHoldMessage('{"name":"SendMessage"}')).toBe(true);
    expect(mayHoldMessage('{"origin":{}}')).toBe(true);
    expect(mayHoldMessage('{"type":"tool_result"}')).toBe(true);
    expect(mayHoldMessage('{"type":"assistant","name":"Read"}')).toBe(false);
  });
});

describe('parseMessageRecord', () => {
  it('rejects bad JSON and other record types', () => {
    expect(parseMessageRecord('{')).toBeNull();
    expect(parseMessageRecord('{"type":"system"}')).toBeNull();
    expect(parseMessageRecord('{"type":"attachment","attachment":{"type":"date"}}')).toBeNull();
  });

  it('falls back to neutral values for odd fields', () => {
    const record = parseMessageRecord(
      JSON.stringify({
        type: 'user',
        uuid: 5,
        origin: 'peer',
        message: {
          content: [
            { type: 'image' },
            { type: 'tool_result', tool_use_id: 't', is_error: 'yes', content: [{ text: 1 }] },
            { type: 'tool_result', tool_use_id: 'u', content: 7 },
          ],
        },
      }),
    );
    expect(record).toStrictEqual({
      type: 'user',
      uuid: null,
      timestamp: null,
      origin: null,
      message: {
        content: [
          { type: 'other' },
          {
            type: 'tool_result',
            tool_use_id: 't',
            is_error: null,
            content: [{ type: 'other', text: null }],
          },
          { type: 'tool_result', tool_use_id: 'u', is_error: null, content: '' },
        ],
      },
    });
  });

  it('reads an origin with missing fields and a queued command', () => {
    expect(
      parseMessageRecord(
        JSON.stringify({
          type: 'attachment',
          uuid: 'u1',
          timestamp: 't',
          attachment: { type: 'queued_command', prompt: 3, origin: { from: 'a1' } },
        }),
      ),
    ).toStrictEqual({
      type: 'attachment',
      uuid: 'u1',
      timestamp: 't',
      attachment: {
        type: 'queued_command',
        prompt: '',
        origin: {
          kind: '',
          from: 'a1',
          name: null,
          senderTaskId: null,
          body: null,
          handback: null,
          handbackReportText: null,
        },
      },
    });
  });

  it('keeps assistant content even when it is not a list', () => {
    expect(
      parseMessageRecord(JSON.stringify({ type: 'assistant', message: { content: 'x' } })),
    ).toStrictEqual({ type: 'assistant', uuid: null, timestamp: null, message: { content: [] } });
    expect(
      parseMessageRecord(JSON.stringify({ type: 'user', message: { content: 4 } })),
    ).toMatchObject({ message: { content: '' } });
  });
});
