// Finds manners and praise in one prompt: please, thanks, great job. The
// reputation view weighs these against the mean prompts.

import { stripIgnored } from './clean.js';
import { buildForms, excerptAround, findMatches, tokenize } from './detect.js';
import { KIND_LEXICON } from './lexicon.js';

export interface Kindness {
  /** Terms in the order they first appear, each once. */
  readonly terms: readonly string[];
  readonly excerpt: string;
}

const FORMS = buildForms(KIND_LEXICON);

/** The kind words in a prompt, or null when there are none. */
export function detectKindness(text: string): Kindness | null {
  const cleaned = stripIgnored(text);
  const matches = findMatches(FORMS, tokenize(cleaned));
  const [first] = matches;
  if (first === undefined) {
    return null;
  }
  return {
    terms: [...new Set(matches.map((match) => match.entry.term))],
    excerpt: excerptAround(cleaned, first.token.start),
  };
}
