// Finds abusive or frustrated language in one prompt and decides whether it
// was aimed at Claude or was general swearing. The word matching here is
// shared with the kindness detector.

import { stripIgnored } from './clean.js';
import type { LexiconEntry } from './lexicon.js';
import { DETERMINERS, LEXICON, SECOND_PERSON } from './lexicon.js';

export type FrustrationTarget = 'claude' | 'general';

export interface Detection {
  /** Terms in the order they first appear, each once. */
  readonly terms: readonly string[];
  readonly target: FrustrationTarget;
  readonly excerpt: string;
}

export interface Token {
  readonly word: string;
  readonly start: number;
  readonly sentence: number;
}

/** A term shown in a view and the normalized spellings that count as it. */
export interface Term {
  readonly term: string;
  readonly forms: readonly string[];
}

interface Form<E extends Term> {
  readonly entry: E;
  readonly words: readonly string[];
}

export interface Match<E extends Term> {
  readonly entry: E;
  readonly token: Token;
  /** Index of the first token. */
  readonly first: number;
}

export type Forms<E extends Term> = ReadonlyMap<string, readonly Form<E>[]>;

export const EXCERPT_CHARS = 80;
const EXCERPT_LEAD = 30;

const TOKEN = /[\p{L}\p{N}*'’]+/gu;
const APOSTROPHES = /['’]/gu;
const REPEATS = /(\p{L})\1{2,}/gu;
const BOUNDARY = /[.!?;\n]/u;
const SPACES = /\s+/gu;
const AFTER_FIRST_WORD = / .*/u;
const STARS = /\*+/gu;

/**
 * Lowercase, apostrophes removed, runs of stars made one, a star at either
 * end dropped (*idiot* reads as idiot) and long letter runs folded.
 */
export function normalizeWord(raw: string): string {
  const squeezed = raw.toLowerCase().replaceAll(APOSTROPHES, '').replaceAll(STARS, '*');
  const start = squeezed.startsWith('*') ? 1 : 0;
  const end = squeezed.endsWith('*') ? squeezed.length - 1 : squeezed.length;
  return squeezed.slice(start, Math.max(start, end)).replaceAll(REPEATS, '$1');
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let sentence = 0;
  let last = 0;
  for (const found of text.matchAll(TOKEN)) {
    if (BOUNDARY.test(text.slice(last, found.index))) {
      sentence += 1;
    }
    last = found.index + found[0].length;
    const word = normalizeWord(found[0]);
    if (word !== '') {
      tokens.push({ word, start: found.index, sentence });
    }
  }
  return tokens;
}

/** Every form keyed by its first word, longest first so a phrase beats its first word. */
export function buildForms<E extends Term>(entries: readonly E[]): Forms<E> {
  const byFirst = new Map<string, Form<E>[]>();
  for (const entry of entries) {
    for (const form of entry.forms) {
      const key = form.replace(AFTER_FIRST_WORD, '');
      byFirst.set(key, [...(byFirst.get(key) ?? []), { entry, words: form.split(' ') }]);
    }
  }
  for (const [key, forms] of byFirst) {
    byFirst.set(
      key,
      forms.toSorted((left, right) => right.words.length - left.words.length),
    );
  }
  return byFirst;
}

const FORMS = buildForms(LEXICON);

function formAt<E extends Term>(
  forms: Forms<E>,
  tokens: readonly Token[],
  index: number,
  word: string,
): Form<E> | undefined {
  return forms
    .get(word)
    ?.find((form) =>
      form.words.every((expected, offset) => tokens[index + offset]?.word === expected),
    );
}

export function findMatches<E extends Term>(forms: Forms<E>, tokens: readonly Token[]): Match<E>[] {
  const matches: Match<E>[] = [];
  // Tokens inside a phrase that already matched are not read again.
  let next = 0;
  for (const [index, token] of tokens.entries()) {
    const form = index < next ? undefined : formAt(forms, tokens, index, token.word);
    if (form !== undefined) {
      matches.push({ entry: form.entry, token, first: index });
      next = index + form.words.length;
    }
  }
  return matches;
}

function isAimed(
  match: Match<LexiconEntry>,
  tokens: readonly Token[],
  spoken: ReadonlySet<number>,
): boolean {
  if (spoken.has(match.token.sentence) || match.entry.kind === 'aimed') {
    return true;
  }
  const before = tokens[match.first - 1]?.word ?? '';
  return match.entry.kind === 'insult' && !DETERMINERS.has(before);
}

/** About EXCERPT_CHARS of text around `start`, on one line, with ... where it was cut. */
export function excerptAround(text: string, start: number): string {
  const from = Math.max(0, Math.min(start - EXCERPT_LEAD, text.length - EXCERPT_CHARS));
  const to = Math.min(text.length, from + EXCERPT_CHARS);
  const body = text.slice(from, to).replaceAll(SPACES, ' ').trim();
  return `${from > 0 ? '...' : ''}${body}${to < text.length ? '...' : ''}`;
}

/** The frustration in a prompt, or null when there is none. */
export function detectFrustration(text: string): Detection | null {
  const cleaned = stripIgnored(text);
  const tokens = tokenize(cleaned);
  const matches = findMatches(FORMS, tokens);
  const [first] = matches;
  if (first === undefined) {
    return null;
  }
  const spoken = new Set(
    tokens.filter((token) => SECOND_PERSON.has(token.word)).map((token) => token.sentence),
  );
  const aimed = matches.some((match) => isAimed(match, tokens, spoken));
  return {
    terms: [...new Set(matches.map((match) => match.entry.term))],
    target: aimed ? 'claude' : 'general',
    excerpt: excerptAround(cleaned, first.token.start),
  };
}
