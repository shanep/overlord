import { describe, expect, it } from 'vitest';

import {
  addUsage,
  errorMessage,
  parsePermissionMode,
  preview,
  toEpochMs,
  toTokenUsage,
} from './events.js';
import { parseContextUsage, parseSdkMessage } from './messages.js';

describe('event helpers', () => {
  it('parses permission modes', () => {
    expect(parsePermissionMode('plan')).toBe('plan');
    expect(parsePermissionMode('manual')).toBe('manual');
    expect(parsePermissionMode('nope')).toBeNull();
  });

  it('converts and adds usage', () => {
    const usage = toTokenUsage({
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: null,
    });
    expect(usage).toStrictEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheCreation: 0,
      thinking: 0,
    });
    expect(
      addUsage(
        { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, thinking: 5 },
        { input: 10, output: 20, cacheRead: 30, cacheCreation: 40, thinking: 50 },
      ),
    ).toStrictEqual({ input: 11, output: 22, cacheRead: 33, cacheCreation: 44, thinking: 55 });
  });

  it('cuts previews at 200 characters', () => {
    expect(preview('a'.repeat(200))).toBe('a'.repeat(200));
    expect(preview('a'.repeat(201))).toBe(`${'a'.repeat(200)}...`);
  });

  it('turns epoch seconds into milliseconds', () => {
    expect(toEpochMs()).toBeNull();
    expect(toEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toEpochMs(999_999_999_999)).toBe(999_999_999_999_000);
    expect(toEpochMs(1_000_000_000_000)).toBe(1_000_000_000_000);
  });

  it('reads error messages', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });
});

describe('message parsing', () => {
  it('returns null for unknown shapes', () => {
    expect(parseSdkMessage({ type: 'result' })).toBeNull();
    expect(parseSdkMessage(42)).toBeNull();
  });

  it('parses context usage and its fill', () => {
    expect(
      parseContextUsage({
        totalTokens: 50,
        maxTokens: 200,
        categories: [
          { name: 'Messages', tokens: 40, kind: 'used', color: 'x' },
          { name: 'Old', tokens: 10 },
        ],
      }),
    ).toStrictEqual({
      totalTokens: 50,
      maxTokens: 200,
      fill: 0.25,
      categories: [
        { name: 'Messages', tokens: 40, kind: 'used' },
        { name: 'Old', tokens: 10, kind: null },
      ],
    });
    expect(parseContextUsage({ totalTokens: 5, maxTokens: 0, categories: [] }).fill).toBe(0);
    expect(() => parseContextUsage({})).toThrow();
  });
});
