import { describe, expect, it } from 'vitest';

import { ZERO_USAGE } from '../../shared/model.js';

import {
  addUsage,
  displayValue,
  isTaskNotification,
  parseTaskNotification,
  preview,
  resultText,
  usageFromRaw,
} from './text.js';

describe('resultText', () => {
  it('returns strings as they are', () => {
    expect(resultText('plain')).toBe('plain');
  });

  it('joins text parts and skips the rest', () => {
    expect(
      resultText([
        { type: 'text', text: 'one' },
        { type: 'image', text: 'ignored' },
        { type: 'text', text: null },
        { type: 'text' },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one\ntwo');
    expect(resultText([])).toBe('');
  });
});

describe('preview', () => {
  it('keeps short text and cuts long text with an ellipsis', () => {
    expect(preview('abc', 3)).toBe('abc');
    expect(preview('abcd', 3)).toBe('abc...');
    expect(preview('', 0)).toBe('');
  });
});

describe('parseTaskNotification', () => {
  const block = [
    '<task-notification>',
    '<task-id>t9</task-id>',
    '<tool-use-id> toolu_abc </tool-use-id>',
    '<status>completed</status>',
    '</task-notification>',
  ].join('\n');

  it('reads the tool use id and status', () => {
    expect(parseTaskNotification(block)).toStrictEqual({
      toolUseId: 'toolu_abc',
      status: 'completed',
    });
    expect(isTaskNotification(block)).toBe(true);
  });

  it('gives null without the tag, the id or the status', () => {
    expect(
      parseTaskNotification('<tool-use-id>x</tool-use-id><status>completed</status>'),
    ).toBeNull();
    expect(isTaskNotification('plain text')).toBe(false);
    expect(parseTaskNotification('<task-notification><status>failed</status>')).toBeNull();
    expect(parseTaskNotification('<task-notification><tool-use-id>x</tool-use-id>')).toBeNull();
  });
});

describe('usage helpers', () => {
  it('maps raw usage, defaulting missing thinking to zero', () => {
    expect(
      usageFromRaw({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
        output_tokens_details: { thinking_tokens: 5 },
      }),
    ).toStrictEqual({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4, thinking: 5 });
    expect(
      usageFromRaw({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
        output_tokens_details: null,
      }).thinking,
    ).toBe(0);
  });

  it('adds field by field', () => {
    const one = { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, thinking: 5 };
    const two = { input: 10, output: 20, cacheRead: 30, cacheCreation: 40, thinking: 50 };
    expect(addUsage(one, two)).toStrictEqual({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheCreation: 44,
      thinking: 55,
    });
    expect(addUsage(ZERO_USAGE, one)).toStrictEqual(one);
  });
});

describe('displayValue', () => {
  it('renders each JSON kind as a string', () => {
    expect(displayValue('zsh')).toBe('zsh');
    expect(displayValue(['/a', ['/b', 3]])).toBe('/a, /b, 3');
    expect(displayValue([])).toBe('');
    expect(displayValue(12)).toBe('12');
    expect(displayValue(false)).toBe('false');
    expect(displayValue(null)).toBe('');
    expect(displayValue([undefined, 'a'])).toBe(', a');
    expect(displayValue({ a: 1 })).toBe('{"a":1}');
  });
});
