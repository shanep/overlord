import { describe, expect, it } from 'vitest';

import { parseJsonc, splitHeader, stripJsonc } from './jsonc.js';

describe('stripJsonc', () => {
  it('drops line and block comments and trailing commas', () => {
    const text = '// top\n{\n  "a": 1, // one\n  /* two */ "b": [1, 2,],\n}\n';
    expect(parseJsonc(text)).toStrictEqual({ ok: true, value: { a: 1, b: [1, 2] } });
  });

  it('keeps comment marks and commas inside strings', () => {
    const text = String.raw`{"url": "https://x.dev/a//b", "glob": "/* not */", "list": "a,]", "q": "\"//"}`;
    expect(JSON.parse(stripJsonc(text))).toStrictEqual({
      url: 'https://x.dev/a//b',
      glob: '/* not */',
      list: 'a,]',
      q: '"//',
    });
  });

  it('runs a comment that never closes to the end', () => {
    expect(stripJsonc('{} /* open')).toBe(`{}${' '.repeat(8)}`);
    expect(stripJsonc('{} // end')).toBe(`{}${' '.repeat(7)}`);
  });

  it('reports JSON that is still broken', () => {
    expect(parseJsonc('{"a": }').ok).toBe(false);
  });
});

describe('splitHeader', () => {
  it('splits the comment lines at the top from the JSON', () => {
    const text = '// User settings\n\n/* kept */\n{\n  "model": "x"\n}\n';
    expect(splitHeader(text)).toStrictEqual({
      header: '// User settings\n\n/* kept */\n',
      body: '{\n  "model": "x"\n}\n',
    });
  });

  it('has no header for plain JSON or an empty file', () => {
    expect(splitHeader('{}\n')).toStrictEqual({ header: '', body: '{}\n' });
    expect(splitHeader('')).toStrictEqual({ header: '', body: '' });
  });

  it('keeps a comment that shares the first JSON line in the body', () => {
    expect(splitHeader('// a\n/* b */ {}')).toStrictEqual({ header: '// a\n', body: '/* b */ {}' });
  });
});
