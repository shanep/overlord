import { describe, expect, it } from 'vitest';

import {
  encodeMessage,
  isEmptyOutput,
  LineDecoder,
  MAX_LINE_BYTES,
  parseReplyLine,
  parseRequestLine,
} from './protocol.js';

describe('encodeMessage', () => {
  it('writes one JSON line', () => {
    expect(encodeMessage({ id: 'a', event: { x: 1 } })).toBe('{"id":"a","event":{"x":1}}\n');
    expect(encodeMessage({ id: 'b', output: {} })).toBe('{"id":"b","output":{}}\n');
  });
});

describe('parseRequestLine', () => {
  it('reads a request from a relay without --agent as Claude Code', () => {
    expect(parseRequestLine('{"id":"r1","event":{"a":2}}')).toStrictEqual({
      id: 'r1',
      event: { a: 2 },
      agent: 'claude-code',
      hook: null,
    });
    expect(parseRequestLine('{"id":"r1","event":null,"agent":"","hook":7}')).toStrictEqual({
      id: 'r1',
      event: null,
      agent: 'claude-code',
      hook: null,
    });
  });

  it('reads the agent and event name the relay was given', () => {
    expect(
      parseRequestLine('{"id":"r1","event":{},"agent":"copilot","hook":"preToolUse"}'),
    ).toStrictEqual({ id: 'r1', event: {}, agent: 'copilot', hook: 'preToolUse' });
    expect(encodeMessage({ id: 'a', event: {}, agent: 'copilot', hook: 'agentStop' })).toBe(
      '{"id":"a","event":{},"agent":"copilot","hook":"agentStop"}\n',
    );
  });

  it('rejects anything that is not a request', () => {
    expect(parseRequestLine('not json')).toBeNull();
    expect(parseRequestLine('[1]')).toBeNull();
    expect(parseRequestLine('null')).toBeNull();
    expect(parseRequestLine('"x"')).toBeNull();
    expect(parseRequestLine('{"event":{}}')).toBeNull();
    expect(parseRequestLine('{"id":3,"event":{}}')).toBeNull();
    expect(parseRequestLine('{"id":"r"}')).toBeNull();
  });
});

describe('parseReplyLine', () => {
  it('reads a reply', () => {
    expect(parseReplyLine('{"id":"r1","output":{"k":true}}')).toStrictEqual({
      id: 'r1',
      output: { k: true },
    });
  });

  it('rejects anything that is not a reply', () => {
    expect(parseReplyLine('{')).toBeNull();
    expect(parseReplyLine('[]')).toBeNull();
    expect(parseReplyLine('{"output":{}}')).toBeNull();
    expect(parseReplyLine('{"id":1,"output":{}}')).toBeNull();
    expect(parseReplyLine('{"id":"r"}')).toBeNull();
    expect(parseReplyLine('{"id":"r","output":null}')).toBeNull();
    expect(parseReplyLine('{"id":"r","output":[]}')).toBeNull();
    expect(parseReplyLine('{"id":"r","output":"x"}')).toBeNull();
  });
});

describe('isEmptyOutput', () => {
  it('is true only for an object with no keys', () => {
    expect(isEmptyOutput({})).toBe(true);
    expect(isEmptyOutput({ a: undefined })).toBe(false);
    expect(isEmptyOutput({ hookSpecificOutput: {} })).toBe(false);
  });
});

describe('LineDecoder', () => {
  it('splits lines across chunks and drops blank ones', () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":')).toStrictEqual([]);
    expect(decoder.push('1}\n\n  \n{"b"')).toStrictEqual(['{"a":1}']);
    expect(decoder.push(':2}\n{"c":3}\n')).toStrictEqual(['{"b":2}', '{"c":3}']);
    expect(decoder.push('')).toStrictEqual([]);
  });

  it('defaults to a 16 MB line cap', () => {
    expect(MAX_LINE_BYTES).toBe(16 * 1024 * 1024);
  });

  it('accepts a partial line at the cap and throws past it', () => {
    const decoder = new LineDecoder(4);
    expect(decoder.push('abcd')).toStrictEqual([]);
    expect(() => decoder.push('e')).toThrow(new RangeError('hook message longer than 4 bytes'));
    // The buffer is cleared after the overflow.
    expect(decoder.push('ok\n')).toStrictEqual(['ok']);
  });

  it('does not count complete lines against the cap', () => {
    const decoder = new LineDecoder(4);
    expect(decoder.push('123456789\nab')).toStrictEqual(['123456789']);
    expect(decoder.push('\n')).toStrictEqual(['ab']);
  });
});
