import { describe, expect, it } from 'vitest';

import {
  isRecord,
  parseFrontmatter,
  parseLoose,
  readFlag,
  readStringList,
  readText,
} from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('returns the whole text as body when there is no frontmatter', () => {
    expect(parseFrontmatter('# Title\nbody')).toStrictEqual({
      data: {},
      body: '# Title\nbody',
      error: null,
    });
  });

  it('ignores an opening marker with no closing marker', () => {
    expect(parseFrontmatter('---\npaths: x\nbody')).toStrictEqual({
      data: {},
      body: '---\npaths: x\nbody',
      error: null,
    });
  });

  it('does not treat a later --- as the opening marker', () => {
    expect(parseFrontmatter('text\n---\na: 1\n---\n').data).toStrictEqual({});
  });

  it('parses valid YAML and splits off the body', () => {
    const result = parseFrontmatter('---\nname: x\npaths:\n  - "src/**"\n---\n# Body\nmore');
    expect(result).toStrictEqual({
      data: { name: 'x', paths: ['src/**'] },
      body: '# Body\nmore',
      error: null,
    });
  });

  it('handles a BOM, CRLF line ends and spaced markers', () => {
    const result = parseFrontmatter('﻿---\r\nname: x\r\n--- \r\nbody');
    expect(result.data).toStrictEqual({ name: 'x' });
    expect(result.body).toBe('body');
    expect(result.error).toBeNull();
  });

  it('treats YAML that is not a mapping as empty', () => {
    expect(parseFrontmatter('---\n- a\n- b\n---\n').data).toStrictEqual({});
    expect(parseFrontmatter('---\njust text\n---\n').data).toStrictEqual({});
    expect(parseFrontmatter('---\n---\nbody')).toStrictEqual({
      data: {},
      body: 'body',
      error: null,
    });
  });

  it('reports invalid YAML and falls back to the loose reading', () => {
    const result = parseFrontmatter('---\nname: v\ndescription: say "hi": now\n---\nbody');
    expect(result.error).toContain('Nested mappings are not allowed');
    expect(result.data).toStrictEqual({ name: 'v', description: 'say "hi": now' });
    expect(result.body).toBe('body');
  });
});

describe('parseLoose', () => {
  it('reads keys, booleans, quotes and lists', () => {
    const text = [
      'name: "quoted"',
      "other: 'single'",
      'flag: true',
      'off: false',
      'paths:',
      '  - src/**',
      '  - "lib/*.ts"',
      'after: x',
      '  - stray',
      'mixed: "half',
    ].join('\n');
    expect(parseLoose(text)).toStrictEqual({
      name: 'quoted',
      other: 'single',
      flag: true,
      off: false,
      paths: ['src/**', 'lib/*.ts'],
      after: 'x',
      mixed: '"half',
    });
  });

  it('ignores indented keys and lines that are not keys', () => {
    expect(parseLoose('  nested: 1\nnot a key\nkey-with_dash: v')).toStrictEqual({
      'key-with_dash': 'v',
    });
  });

  it('keeps an empty key as an empty string until list items arrive', () => {
    expect(parseLoose('empty:')).toStrictEqual({ empty: '' });
    expect(parseLoose('list:\n- one')).toStrictEqual({ list: ['one'] });
  });

  it('never touches the object prototype', () => {
    const result = parseLoose('__proto__: polluted');
    expect(Object.entries(result)).toStrictEqual([['__proto__', 'polluted']]);
    expect(result).toBeInstanceOf(Object);
    expect(Object.keys(result)).toStrictEqual(['__proto__']);
  });
});

describe('readStringList', () => {
  it('splits a comma string outside brace groups', () => {
    expect(readStringList('src/*.{ts,tsx}, lib/**')).toStrictEqual(['src/*.{ts,tsx}', 'lib/**']);
    expect(readStringList('a,{b,{c,d}},e')).toStrictEqual(['a', '{b,{c,d}}', 'e']);
    expect(readStringList('a},b')).toStrictEqual(['a}', 'b']);
    expect(readStringList(' , x ,')).toStrictEqual(['x']);
  });

  it('reads YAML lists and drops non-strings and blanks', () => {
    expect(readStringList([' a ', 1, '', '  ', null, 'b'])).toStrictEqual(['a', 'b']);
  });

  it('returns nothing for other values', () => {
    expect(readStringList(null)).toStrictEqual([]);
    expect(readStringList(7)).toStrictEqual([]);
    expect(readStringList({ a: 1 })).toStrictEqual([]);
  });
});

describe('small readers', () => {
  it('reads flags', () => {
    expect(readFlag(true)).toBe(true);
    expect(readFlag('true')).toBe(true);
    expect(readFlag(false)).toBe(false);
    expect(readFlag('yes')).toBe(false);
    expect(readFlag(1)).toBe(false);
  });

  it('reads text', () => {
    expect(readText('x')).toBe('x');
    expect(readText('')).toBe('');
    expect(readText(1)).toBeNull();
  });

  it('recognizes plain records', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });
});
