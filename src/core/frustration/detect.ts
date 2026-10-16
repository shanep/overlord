// Finds abusive or frustrated language in one prompt and decides whether it
// was aimed at Claude or was general swearing.

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

interface Token {
  readonly word: string;
  readonly start: number;
  readonly sentence: number;
}

interface Form {
  readonly entry: LexiconEntry;
  readonly words: readonly string[];
}

interface Match {
  readonly entry: LexiconEntry;
  readonly token: Token;
  /** Index of the first token. */
  readonly first: number;
}

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

function tokenize(text: string): Token[] {
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
function buildForms(entries: readonly LexiconEntry[]): ReadonlyMap<string, readonly Form[]> {
  const byFirst = new Map<string, Form[]>();
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

function formAt(tokens: readonly Token[], index: number, word: string): Form | undefined {
  return FORMS.get(word)?.find((form) =>
    form.words.every((expected, offset) => tokens[index + offset]?.word === expected),
  );
}

function findMatches(tokens: readonly Token[]): Match[] {
  const matches: Match[] = [];
  // Tokens inside a phrase that already matched are not read again.
  let next = 0;
  for (const [index, token] of tokens.entries()) {
    const form = index < next ? undefined : formAt(tokens, index, token.word);
    if (form !== undefined) {
      matches.push({ entry: form.entry, token, first: index });
      next = index + form.words.length;
    }
  }
  return matches;
}

function isAimed(match: Match, tokens: readonly Token[], spoken: ReadonlySet<number>): boolean {
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
  const matches = findMatches(tokens);
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
