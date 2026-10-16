// cspell:ignore xabbcx
import { describe, expect, it } from 'vitest';

import {
  capture,
  cell,
  cleanText,
  codeSpans,
  parseTables,
  slugify,
  splitRow,
  stripQuotes,
} from './markdown.js';

const EM_DASH = String.fromCodePoint(0x20_14);
const EN_DASH = String.fromCodePoint(0x20_13);

describe('cleanText', () => {
  it('keeps link text and drops the target', () => {
    expect(cleanText('See [the docs](/docs/en/x#y) now')).toBe('See the docs now');
    expect(cleanText('![logo](/img.png) here')).toBe('logo here');
  });

  it('drops HTML tags but keeps their text', () => {
    expect(cleanText('a <span id="x" /> b <b>bold</b>')).toBe('a b bold');
    expect(cleanText('keep <model> placeholders? no: 1 < 2')).toBe('keep placeholders? no: 1 < 2');
  });

  it('unescapes pipes and angle brackets and drops backticks and bold', () => {
    const escaped = String.raw`one \| two \<three>`;
    expect(cleanText(`${escaped} **four** \`five\``)).toBe('one | two <three> four five');
  });

  it('turns em and en dashes into ", " whatever the spacing', () => {
    expect(cleanText(`fast ${EM_DASH} cheap`)).toBe('fast, cheap');
    expect(cleanText(`fast${EM_DASH}cheap`)).toBe('fast, cheap');
    expect(cleanText(`pages 1${EN_DASH}5`)).toBe('pages 1, 5');
    expect(cleanText(`a ${EN_DASH} b ${EM_DASH} c`)).toBe('a, b, c');
  });

  it('collapses whitespace and trims', () => {
    expect(cleanText('  a \n\t b   c  ')).toBe('a b c');
    expect(cleanText('')).toBe('');
  });
});

describe('capture', () => {
  it('returns the first group, or null with no match or no group', () => {
    expect(capture(/a(b+)c/u, 'xabbcx')).toBe('bb');
    expect(capture(/a(b+)c/u, 'xyz')).toBeNull();
    expect(capture(/a(b)?c/u, 'ac')).toBeNull();
    expect(capture(/a(b*)c/u, 'ac')).toBe('');
  });
});

describe('cell', () => {
  it('returns the cell or an empty string past the end', () => {
    expect(cell(['a', 'b'], 0)).toBe('a');
    expect(cell(['a', 'b'], 1)).toBe('b');
    expect(cell(['a', 'b'], 2)).toBe('');
  });
});

describe('codeSpans', () => {
  it('lists every non-empty code span in order', () => {
    expect(codeSpans('use `a` then `b c` and `d`')).toStrictEqual(['a', 'b c', 'd']);
    expect(codeSpans('no code here')).toStrictEqual([]);
    expect(codeSpans('empty `` span')).toStrictEqual([]);
    expect(codeSpans('`first`')).toStrictEqual(['first']);
  });
});

describe('stripQuotes', () => {
  it('drops one pair of surrounding double quotes only', () => {
    expect(stripQuotes('"auto"')).toBe('auto');
    expect(stripQuotes('""')).toBe('');
    expect(stripQuotes('"')).toBe('"');
    expect(stripQuotes('"open')).toBe('"open');
    expect(stripQuotes('close"')).toBe('close"');
    expect(stripQuotes('plain')).toBe('plain');
    expect(stripQuotes('""x""')).toBe('"x"');
  });
});

describe('slugify', () => {
  it('builds the docs anchor for a heading', () => {
    expect(slugify('CLI flags')).toBe('cli-flags');
    expect(slugify('System prompt `flags`!')).toBe('system-prompt-flags');
    expect(slugify('  Lists  merge, instead ')).toBe('lists-merge-instead');
    expect(slugify('a-b c')).toBe('a-b-c');
    expect(slugify('Hello !')).toBe('hello');
    expect(slugify('a ! b')).toBe('a-b');
  });
});

describe('splitRow', () => {
  it('splits on unescaped pipes and trims cells', () => {
    expect(splitRow(String.raw`| a | b \| c |  `)).toStrictEqual(['a', String.raw`b \| c`]);
    expect(splitRow('a | b')).toStrictEqual(['a', 'b']);
    expect(splitRow('|  only  |')).toStrictEqual(['only']);
  });
});

describe('parseTables', () => {
  it('finds each table with its header, rows and heading', () => {
    const markdown = [
      '# Title',
      '',
      '| not a | table |',
      'plain text',
      '## First',
      '',
      '| Key | Value |',
      '| :- | -: |',
      '| a | 1 |',
      '| b | 2 |',
      '',
      '### Second `part`',
      '| Only |',
      '| --- |',
      '| x |',
    ].join('\n');
    expect(parseTables(markdown)).toStrictEqual([
      {
        heading: 'First',
        header: ['Key', 'Value'],
        rows: [
          ['a', '1'],
          ['b', '2'],
        ],
      },
      { heading: 'Second `part`', header: ['Only'], rows: [['x']] },
    ]);
  });

  it('needs a dash in the separator row and a row right above it', () => {
    expect(parseTables('| a |\n| : |\n| b |')).toStrictEqual([]);
    expect(parseTables('| a |\n\n| --- |')).toStrictEqual([]);
    expect(parseTables('text\n| --- |')).toStrictEqual([]);
    expect(parseTables('| a |\n| --- | x')).toStrictEqual([]);
  });

  it('ends a table at the first line that is not a row', () => {
    const tables = parseTables('| h |\n|---|\n| 1 |\nafter\n| 2 |');
    expect(tables).toStrictEqual([{ heading: '', header: ['h'], rows: [['1']] }]);
  });

  it('keeps a table with no rows and starts a new one right after', () => {
    const tables = parseTables('| h |\n|---|\n\n| i |\n|---|\n| 1 |');
    expect(tables).toStrictEqual([
      { heading: '', header: ['h'], rows: [] },
      { heading: '', header: ['i'], rows: [['1']] },
    ]);
  });

  it('accepts indented rows and rows without a trailing pipe', () => {
    expect(parseTables('  | h | i\n  | - | - |\n  | 1 | 2')).toStrictEqual([
      { heading: '', header: ['h', 'i'], rows: [['1', '2']] },
    ]);
  });

  it('only treats "#" followed by a space as a heading', () => {
    const tables = parseTables('## Real\n#hashtag\n| h |\n|---|');
    expect(tables).toStrictEqual([{ heading: 'Real', header: ['h'], rows: [] }]);
  });
});
