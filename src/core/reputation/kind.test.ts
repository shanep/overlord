import { describe, expect, it } from 'vitest';

import { detectKindness } from './kind.js';

function terms(text: string): readonly string[] | undefined {
  return detectKindness(text)?.terms;
}

describe('detectKindness', () => {
  it('finds manners and praise, each term once in the order it first appears', () => {
    expect(terms('Please fix the build, thanks!')).toStrictEqual(['please', 'thanks']);
    expect(terms('Thank you so much, great job. Thank you again.')).toStrictEqual([
      'thanks',
      'great job',
    ]);
    expect(terms('pls run it, ty')).toStrictEqual(['please', 'thanks']);
    expect(terms("You're the best")).toStrictEqual(['you rock']);
    expect(terms('Good catch, I love it')).toStrictEqual(['good catch', 'love it']);
    expect(terms('PERFECT')).toStrictEqual(['perfect']);
  });

  it('finds nothing in plain prompts, code, quotes or urls', () => {
    expect(detectKindness('fix the build and run the tests')).toBeNull();
    expect(detectKindness('rename `pleaseWait` to `wait`')).toBeNull();
    expect(detectKindness('```\nprint("thanks")\n```')).toBeNull();
    expect(detectKindness('> thanks for the report\nfix it')).toBeNull();
    expect(detectKindness('see https://example.com/thank-you')).toBeNull();
    expect(detectKindness('the perfectionist module')).toBeNull();
  });

  it('keeps an excerpt around the first kind word', () => {
    expect(detectKindness('Could you please fix it')?.excerpt).toBe('Could you please fix it');
  });
});
