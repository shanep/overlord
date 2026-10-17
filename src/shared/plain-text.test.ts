import { describe, expect, it } from 'vitest';

import { plainText } from './plain-text.js';

describe('plainText', () => {
  it('drops color, cursor and title escapes', () => {
    expect(plainText('\u001B[34mDocs\u001B[39;49m\u001B[0m')).toBe('Docs');
    expect(plainText('\u001B[38;2;56;56;56mGrey\u001B[m \u001B[1B\u001B[12Gok')).toBe('Grey ok');
    expect(plainText('\u001B]0;title\u0007run \u001B]8;;https://x\u001B\\link')).toBe('run link');
    expect(plainText('\u009B31mRed')).toBe('Red');
  });

  it('keeps tabs and newlines and lets a carriage return overwrite its line', () => {
    expect(plainText('a\tb\r\nc')).toBe('a\tb\nc');
    expect(plainText('10%\r50%\r100%\ndone')).toBe('100%\ndone');
  });

  it('drops other control characters', () => {
    expect(plainText('a\u0000b\u0008c\u007Fd\u0085e')).toBe('abcde');
  });

  it('leaves plain text alone', () => {
    expect(plainText('Café: 3 tests pass, 0 fail.')).toBe('Café: 3 tests pass, 0 fail.');
  });
});
