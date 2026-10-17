import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { stripIgnored } from './clean.js';
import { detectFrustration, EXCERPT_CHARS, excerptAround, normalizeWord } from './detect.js';
import { DETERMINERS, LEXICON, SECOND_PERSON } from './lexicon.js';

const ALL_FORMS: readonly string[] = LEXICON.flatMap((entry) => entry.forms);

// Words that are not hits on their own and cannot start a phrase that is one.
const NEUTRAL: readonly string[] = [
  'fix',
  'shell',
  'script',
  'class',
  'Assistant',
  'please',
  'run',
  'tests',
  'now',
  'build',
  'hello',
  'pass',
  'assess',
  'scrap',
  'shitake',
  'Scunthorpe',
  'hellish',
  'documented',
];

function terms(text: string): readonly string[] | undefined {
  return detectFrustration(text)?.terms;
}

function target(text: string): string | undefined {
  return detectFrustration(text)?.target;
}

describe('detectFrustration on real shaped prompts', () => {
  it('finds the hits aimed at Claude', () => {
    expect(detectFrustration('what are you doing? hurry up dumbass')).toStrictEqual({
      terms: ['hurry up', 'dumbass'],
      target: 'agent',
      excerpt: 'what are you doing? hurry up dumbass',
    });
    expect(
      detectFrustration('why are you not using multiple agents this is too slow you numskull!'),
    ).toStrictEqual({
      terms: ['numskull'],
      target: 'agent',
      excerpt: 'why are you not using multiple agents this is too slow you numskull!',
    });
    expect(
      detectFrustration(
        'I told you not to fuck shit up and here you go not having a gitignore what is your issue?',
      ),
    ).toStrictEqual({
      terms: ['fuck', 'shit'],
      target: 'agent',
      excerpt:
        'I told you not to fuck shit up and here you go not having a gitignore what is yo...',
    });
    expect(detectFrustration('hurry up with this shit you slow fuck')).toStrictEqual({
      terms: ['hurry up', 'shit', 'fuck'],
      target: 'agent',
      excerpt: 'hurry up with this shit you slow fuck',
    });
  });

  it('counts a long prompt once, with the second person in the sentence that swears', () => {
    const text =
      'Then I want a new view that displays and somehow maintains how many times the user uses ' +
      'abusive language towards you and in general. That way they can see how many times you ' +
      'have fucked shit up';
    expect(detectFrustration(text)).toStrictEqual({
      terms: ['fuck', 'shit'],
      target: 'agent',
      excerpt:
        '...you and in general. That way they can see how many times you have fucked shit up',
    });
  });

  it('leaves neutral text alone', () => {
    expect(detectFrustration('fix the shell script')).toBeNull();
    expect(detectFrustration('class Assistant')).toBeNull();
    expect(detectFrustration('')).toBeNull();
    expect(detectFrustration('Scunthorpe hello assess classic')).toBeNull();
  });
});

describe('detectFrustration targets', () => {
  it('calls swearing general unless its sentence says you', () => {
    expect(target('this API is shit')).toBe('general');
    expect(target('your API is shit')).toBe('agent');
    expect(target('YOU broke it, shit')).toBe('agent');
  });

  it('splits sentences on . ! ? ; and new lines', () => {
    for (const mark of ['.', '!', '?', ';', '\n']) {
      expect(target(`you are here${mark} this is shit`)).toBe('general');
    }
    expect(target('you are here, this is shit')).toBe('agent');
    expect(target('a. you shit')).toBe('agent');
  });

  it('treats every second person word as aimed', () => {
    expect(SECOND_PERSON.size).toBe(10);
    for (const word of SECOND_PERSON) {
      expect(target(`${word} wrote shit`)).toBe('agent');
    }
    expect(target("you're useless")).toBe('agent');
    expect(target('you’re useless')).toBe('agent');
  });

  it('calls name-calling aimed unless a determiner points elsewhere', () => {
    expect(target('fix it idiot')).toBe('agent');
    expect(target('idiot')).toBe('agent');
    expect(target('what an idiot')).toBe('agent');
    expect(DETERMINERS.size).toBe(13);
    for (const word of DETERMINERS) {
      expect(target(`${word} idiot wrote this`)).toBe('general');
    }
    expect(target('you are the idiot')).toBe('agent');
  });

  it('calls a mix aimed when any hit is aimed', () => {
    expect(target('this is shit. fix it idiot')).toBe('agent');
    expect(target('the idiot wrote shit')).toBe('general');
  });
});

describe('detectFrustration terms', () => {
  it('knows every form and its kind', () => {
    expect(LEXICON).toHaveLength(31);
    expect(ALL_FORMS).toHaveLength(90);
    for (const entry of LEXICON) {
      for (const form of entry.forms) {
        const found = detectFrustration(form);
        expect(found?.terms).toStrictEqual([entry.term]);
        expect(found?.target).toBe(entry.kind === 'swear' ? 'general' : 'agent');
      }
    }
  });

  it('prefers the longest phrase and reads the next word after it', () => {
    expect(terms('this is fucked up')).toStrictEqual(['fucked up']);
    expect(terms('what the fuck idiot')).toStrictEqual(['wtf', 'idiot']);
    expect(terms('hurry the fuck up')).toStrictEqual(['hurry up']);
    expect(terms('fucked shit up')).toStrictEqual(['fuck', 'shit']);
    expect(terms('hurry')).toBeUndefined();
  });

  it('lists each term once, in order', () => {
    expect(terms('shit shit fuck shit')).toStrictEqual(['shit', 'fuck']);
  });

  it('matches whole words in any case, with stars, quotes and long letter runs', () => {
    expect(terms('FUCK')).toStrictEqual(['fuck']);
    expect(terms('** idiot **')).toStrictEqual(['idiot']);
    expect(target('the ** idiot')).toBe('general');
    expect(terms('*idiot*')).toStrictEqual(['idiot']);
    expect(terms("'idiot'")).toStrictEqual(['idiot']);
    expect(terms('f**k this')).toStrictEqual(['fuck']);
    expect(terms('fuuuuuck')).toStrictEqual(['fuck']);
    expect(terms('for fuck’s sake')).toStrictEqual(['ffs']);
    expect(terms('shitake mushrooms')).toBeUndefined();
    expect(terms('unfucked')).toBeUndefined();
  });
});

describe('normalizeWord', () => {
  it('lowercases, drops apostrophes, squeezes stars and folds runs', () => {
    expect(normalizeWord('FUCK')).toBe('fuck');
    expect(normalizeWord("you're")).toBe('youre');
    expect(normalizeWord('you’re')).toBe('youre');
    expect(normalizeWord('f**k')).toBe('f*k');
    expect(normalizeWord('*idiot*')).toBe('idiot');
    expect(normalizeWord('**idiot')).toBe('idiot');
    expect(normalizeWord('idiot**')).toBe('idiot');
    expect(normalizeWord('*')).toBe('');
    expect(normalizeWord('fuuuuck')).toBe('fuck');
    expect(normalizeWord('fuuck')).toBe('fuuck');
    expect(normalizeWord('aaa')).toBe('a');
    expect(normalizeWord('111')).toBe('111');
  });
});

describe('ignored text', () => {
  it('skips fenced code, open fences and tilde fences', () => {
    expect(detectFrustration('```\nyou idiot\n```')).toBeNull();
    expect(detectFrustration('  ```ts\nyou idiot\n```\nok')).toBeNull();
    expect(detectFrustration('~~~\nyou idiot\n~~~')).toBeNull();
    expect(detectFrustration('look\n```\nyou idiot')).toBeNull();
    expect(terms('```\ncode\n```\nyou idiot')).toStrictEqual(['idiot']);
    expect(terms('``\nyou idiot')).toStrictEqual(['idiot']);
    expect(terms('note ``` here\nyou idiot')).toStrictEqual(['idiot']);
  });

  it('skips inline code, quoted lines, pasted content, reminders and URLs', () => {
    expect(detectFrustration('see `shit` here')).toBeNull();
    expect(terms('`code\nyou idiot')).toStrictEqual(['idiot']);
    expect(detectFrustration('> you idiot')).toBeNull();
    expect(detectFrustration('  > you idiot')).toBeNull();
    expect(terms('a > b, you idiot')).toStrictEqual(['idiot']);
    expect(
      detectFrustration('<pasted_content id="b7ab">\nyou idiot\n</pasted_content>'),
    ).toBeNull();
    expect(terms('<pasted_content id="x">fine</pasted_content> you idiot')).toStrictEqual([
      'idiot',
    ]);
    expect(detectFrustration('<pasted_content>you idiot')).toBeNull();
    expect(detectFrustration('<system-reminder>you idiot</system-reminder>')).toBeNull();
    expect(terms('<system-reminder>x</pasted_content> idiot</system-reminder>')).toBeUndefined();
    expect(detectFrustration('https://example.com/shit')).toBeNull();
    expect(detectFrustration(['see http', '//x.io/idiot'].join(':'))).toBeNull();
    expect(detectFrustration('HTTPS://EXAMPLE.COM/SHIT www.shit.com')).toBeNull();
  });

  it('keeps line breaks so sentences stay apart', () => {
    expect(stripIgnored('a\n> b\nc')).toBe('a\n\nc');
    expect(stripIgnored('a\n```\nb\n```\nc')).toBe('a\n\n\n\nc');
    expect(stripIgnored('a `b` c')).toBe('a   c');
    expect(stripIgnored('go www.x.io now')).toBe('go   now');
    expect(stripIgnored('a<pasted_content>b</pasted_content>c')).toBe('a\nc');
  });
});

describe('excerptAround', () => {
  const long = `${'a'.repeat(100)} target ${'b'.repeat(100)}`;

  it('keeps short text whole', () => {
    expect(excerptAround('one  two\nthree', 4)).toBe('one two three');
    expect(excerptAround('  x  ', 2)).toBe('x');
  });

  it('cuts long text around the match', () => {
    const excerpt = excerptAround(long, 101);
    expect(excerpt).toBe(`...${'a'.repeat(29)} target ${'b'.repeat(43)}...`);
    expect(excerpt).toHaveLength(EXCERPT_CHARS + 6);
  });

  it('shifts the window back at the end and starts at zero at the start', () => {
    expect(excerptAround(long, long.length - 1)).toBe(`...${'b'.repeat(80)}`);
    expect(excerptAround(long, 5)).toBe(`${'a'.repeat(80)}...`);
  });
});

describe('detectFrustration properties', () => {
  const word = fc.constantFrom(...ALL_FORMS, ...NEUTRAL);
  const neutral = fc.array(fc.constantFrom(...NEUTRAL), { maxLength: 8 });

  it('never matches inside a code fence or inline code', () => {
    fc.assert(
      fc.property(fc.array(word, { maxLength: 12 }), (words) => {
        const body = words.join(' ');
        expect(detectFrustration(`\`\`\`\n${body}\n\`\`\``)).toBeNull();
        expect(detectFrustration(`\`${body}\``)).toBeNull();
      }),
    );
  });

  it('keeps a hit a hit with neutral words around it', () => {
    fc.assert(
      fc.property(neutral, fc.constantFrom(...ALL_FORMS), neutral, (before, hit, after) => {
        const found = detectFrustration([...before, hit, ...after].join(' '));
        expect(found).not.toBeNull();
        expect(found?.excerpt).toContain(hit);
      }),
    );
  });
});
