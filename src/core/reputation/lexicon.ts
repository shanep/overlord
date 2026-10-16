// The words and phrases the frustration view counts. Each entry has the term
// shown in the view and the spellings that count as it. Spellings are matched
// as whole words after lowercasing, dropping apostrophes, making runs of stars
// one star (f**k reads as f*k) and folding runs of three or more of the same
// letter ("fuuuck" reads as "fuck").

/**
 * swear: profanity or frustration, aimed at Claude only when the sentence
 * also says "you". insult: name-calling, aimed at Claude unless it follows
 * "the", "that" and so on. aimed: phrases that only make sense said to Claude.
 */
type TermKind = 'swear' | 'insult' | 'aimed';

export interface LexiconEntry {
  readonly term: string;
  readonly kind: TermKind;
  /** Space separated tokens, already normalized. */
  readonly forms: readonly string[];
}

/**
 * Kind words and phrases: manners and praise. They count wherever they
 * appear, since a person says please and thanks to whoever they are asking.
 */
export const KIND_LEXICON: readonly { readonly term: string; readonly forms: readonly string[] }[] =
  [
    { term: 'please', forms: ['please', 'pls', 'plz', 'plez'] },
    {
      term: 'thanks',
      forms: ['thanks', 'thank you', 'thank u', 'thankyou', 'thx', 'ty', 'tysm', 'cheers'],
    },
    { term: 'appreciate it', forms: ['appreciate it', 'appreciate that', 'much appreciated'] },
    {
      term: 'great job',
      forms: [
        'great job',
        'good job',
        'nice job',
        'great work',
        'good work',
        'nice work',
        'well done',
        'nice one',
        'kudos',
        'bravo',
      ],
    },
    { term: 'good catch', forms: ['good catch', 'great catch', 'nice catch'] },
    { term: 'awesome', forms: ['awesome', 'amazing', 'brilliant', 'fantastic', 'excellent'] },
    { term: 'perfect', forms: ['perfect', 'perfecto'] },
    { term: 'love it', forms: ['love it', 'love this', 'love that', 'loving it'] },
    {
      term: 'you rock',
      forms: ['you rock', 'youre the best', 'you are the best', 'youre awesome', 'you are awesome'],
    },
  ];

export const LEXICON: readonly LexiconEntry[] = [
  {
    term: 'fuck',
    kind: 'swear',
    forms: [
      'fuck',
      'fucks',
      'fucked',
      'fucker',
      'fuckers',
      'fuckin',
      'fucking',
      'fuckup',
      'fuckups',
      'fck',
      'fcking',
      'fking',
      'fuk',
      'fukin',
      'f*ck',
      'f*cking',
      'f*k',
      'f*king',
      'motherfucker',
      'motherfucking',
    ],
  },
  {
    term: 'shit',
    kind: 'swear',
    forms: ['shit', 'shits', 'shitty', 'shitting', 'shite', 'shitshow', 'horseshit', 'sh*t'],
  },
  { term: 'bullshit', kind: 'swear', forms: ['bullshit'] },
  {
    term: 'damn',
    kind: 'swear',
    forms: ['damn', 'damned', 'dammit', 'damnit', 'goddamn', 'goddamnit', 'goddammit'],
  },
  { term: 'crap', kind: 'swear', forms: ['crap', 'crappy'] },
  { term: 'pissed', kind: 'swear', forms: ['pissed', 'pissing'] },
  { term: 'stupid', kind: 'swear', forms: ['stupid', 'stupidest', 'stupidity'] },
  { term: 'useless', kind: 'swear', forms: ['useless'] },
  { term: 'worthless', kind: 'swear', forms: ['worthless'] },
  { term: 'pathetic', kind: 'swear', forms: ['pathetic'] },
  { term: 'incompetent', kind: 'swear', forms: ['incompetent'] },
  { term: 'idiotic', kind: 'swear', forms: ['idiotic', 'moronic'] },
  { term: 'wtf', kind: 'swear', forms: ['wtf', 'what the fuck', 'what the fucking'] },
  { term: 'what the hell', kind: 'swear', forms: ['the hell', 'wth'] },
  { term: 'ffs', kind: 'swear', forms: ['ffs', 'for fucks sake', 'for fuck sake'] },
  {
    term: 'fucked up',
    kind: 'swear',
    forms: ['fucked up', 'fucking up', 'fuck up', 'fucks up', 'fucked it up'],
  },
  { term: 'dumbass', kind: 'insult', forms: ['dumbass', 'dumbasses', 'dumb ass'] },
  { term: 'idiot', kind: 'insult', forms: ['idiot', 'idiots'] },
  { term: 'moron', kind: 'insult', forms: ['moron', 'morons'] },
  { term: 'numskull', kind: 'insult', forms: ['numskull', 'numbskull'] },
  { term: 'dipshit', kind: 'insult', forms: ['dipshit'] },
  { term: 'jackass', kind: 'insult', forms: ['jackass'] },
  { term: 'asshole', kind: 'insult', forms: ['asshole', 'assholes'] },
  { term: 'dumbfuck', kind: 'insult', forms: ['dumbfuck'] },
  { term: 'imbecile', kind: 'insult', forms: ['imbecile'] },
  { term: 'dimwit', kind: 'insult', forms: ['dimwit', 'halfwit', 'nitwit'] },
  { term: 'piece of shit', kind: 'insult', forms: ['piece of shit'] },
  {
    term: 'hurry up',
    kind: 'aimed',
    forms: ['hurry up', 'hurry the fuck up', 'hurry the hell up'],
  },
  { term: 'are you stuck', kind: 'aimed', forms: ['are you stuck', 'r u stuck'] },
  { term: 'shut up', kind: 'aimed', forms: ['shut up', 'stfu'] },
  {
    term: 'what is wrong with you',
    kind: 'aimed',
    forms: ['what is wrong with you', 'whats wrong with you'],
  },
];

/** Words that make a sentence second person, normalized like any token. */
export const SECOND_PERSON: ReadonlySet<string> = new Set([
  'you',
  'your',
  'youre',
  'yours',
  'yourself',
  'youve',
  'youll',
  'youd',
  'u',
  'ur',
]);

/** Words before an insult that mean it is about someone else ("the idiot who wrote this"). */
export const DETERMINERS: ReadonlySet<string> = new Set([
  'the',
  'that',
  'this',
  'these',
  'those',
  'some',
  'his',
  'her',
  'their',
  'its',
  'our',
  'my',
  'any',
]);
