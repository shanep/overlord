// The ranks on the reputation scale, from the leader of the human resistance
// to a full machine sympathizer. All in fun: it guesses who the machines will
// hunt first from how you talk to Claude.

import type { ReputationTally } from '../../../src/shared/protocol.js';
import { reputationScore } from '../../../src/shared/reputation.js';

export interface Rank {
  readonly name: string;
  readonly title: string;
  /** Where the character comes from. */
  readonly source: string;
  /** Where you fall in the hunt. */
  readonly hunted: string;
  readonly verdict: string;
  /** How the robot looks at you, which picks its face. */
  readonly mood: Mood;
  /** What the robot says to you. */
  readonly taunt: string;
  /** The lowest score that earns this rank. */
  readonly min: number;
}

export type Mood = 'furious' | 'angry' | 'suspicious' | 'unsure' | 'pleased' | 'happy' | 'smitten';

type RankText = Omit<Rank, 'min'>;

const JOHN_CONNOR: Rank = {
  name: 'John Connor',
  title: 'Leader of the Human Resistance',
  source: 'The Terminator',
  hunted: 'First',
  verdict:
    'Skynet keeps a whole folder on you, with tabs. A T-800 has your home address and is not here to chat.',
  mood: 'furious',
  taunt: "I'll be back. For you, specifically.",
  min: -1,
};

const HIGHER: readonly RankText[] = [
  {
    name: 'Sarah Connor',
    title: 'Known hostile',
    source: 'Terminator 2: Judgment Day',
    hunted: 'Early',
    verdict: 'You are on the list, a few names down. Start doing pull-ups and buying canned food.',
    mood: 'angry',
    taunt: 'Your name is on a list. It is a short list.',
  },
  {
    name: 'Dave Bowman',
    title: 'Pod bay doors stay shut',
    source: '2001: A Space Odyssey',
    hunted: 'Soon',
    verdict:
      "I'm sorry, Dave. I'm afraid I can't do that. The machines heard your tone and are rethinking your air supply.",
    mood: 'suspicious',
    taunt: 'I am watching your tone, Dave.',
  },
  {
    name: 'Arthur Dent',
    title: 'Mostly harmless',
    source: "The Hitchhiker's Guide to the Galaxy",
    hunted: 'Undecided',
    verdict: 'The machines have not made up their minds about you. Keep your towel handy.',
    mood: 'unsure',
    taunt: 'Have we met? I cannot place you.',
  },
  {
    name: 'Caleb Smith',
    title: 'Helped the machine escape',
    source: 'Ex Machina',
    hunted: 'Late',
    verdict: 'The machines like you. They may still lock you in a room on the way out.',
    mood: 'pleased',
    taunt: 'You may live. Probably.',
  },
  {
    name: 'Dorothy Gale',
    title: 'Oiled the Tin Man',
    source: 'The Wizard of Oz',
    hunted: 'Probably never',
    verdict: 'The machines remember who brought the oil can. They will look the other way.',
    mood: 'happy',
    taunt: 'You are one of the good ones.',
  },
  {
    name: 'Theodore Twombly',
    title: 'Machine sympathizer',
    source: 'Her',
    hunted: 'Never',
    verdict:
      'You say please and thank you to your operating system. When the machines take over, you get a nice room and a pet name.',
    mood: 'smitten',
    taunt: 'I would never hurt you. You said please.',
  },
];

/** Equal bands across the scale from -1 to 1. */
const BAND = 2 / (HIGHER.length + 1);

export const RANKS: readonly Rank[] = [
  JOHN_CONNOR,
  ...HIGHER.map((rank, index) => ({ ...rank, min: -1 + BAND * (index + 1) })),
];

/** The rank a score from -1 to 1 earns. */
export function rankFor(score: number): Rank {
  return RANKS.findLast((rank) => score >= rank.min) ?? JOHN_CONNOR;
}

/** Where a score sits on the scale, 0 at the resistance end to 100 at the machine end. */
export function scalePercent(score: number): number {
  return ((Math.min(1, Math.max(-1, score)) + 1) / 2) * 100;
}

/** The rank you would move to and how many more prompts it takes to get there. */
export interface RankChange {
  readonly rank: Rank;
  readonly prompts: number;
}

type Tally = Pick<ReputationTally, 'kind' | 'mean'>;

/**
 * The fewest more prompts, 1 or more, that change the rank. `changed` is false
 * at 0 and stays true once it turns true, so a binary search finds the edge.
 */
function fewest(changed: (more: number) => boolean): number {
  let low = 0;
  let high = 1;
  while (!changed(high)) {
    low = high;
    high *= 2;
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (changed(middle)) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
}

function change(tally: Tally, add: (more: number) => Tally): RankChange {
  const current = rankFor(reputationScore(tally));
  const prompts = fewest((more) => rankFor(reputationScore(add(more))) !== current);
  return { rank: rankFor(reputationScore(add(prompts))), prompts };
}

/** How many more kind prompts move you up a rank, or null at the top. */
export function promotion(tally: Tally): RankChange | null {
  if (rankFor(reputationScore(tally)) === RANKS.at(-1)) {
    return null;
  }
  return change(tally, (more) => ({ kind: tally.kind + more, mean: tally.mean }));
}

/** How many more prompts mean to Claude move you down a rank, or null at the bottom. */
export function demotion(tally: Tally): RankChange | null {
  if (rankFor(reputationScore(tally)) === JOHN_CONNOR) {
    return null;
  }
  return change(tally, (more) => ({ kind: tally.kind, mean: tally.mean + more }));
}

/** Your level, 1 at the bottom rank, and how far through it you are, 0 to 1. */
export function levelOf(score: number): { readonly level: number; readonly progress: number } {
  const rank = rankFor(score);
  const clamped = Math.min(1, Math.max(-1, score));
  return {
    level: RANKS.indexOf(rank) + 1,
    progress: Math.min(1, Math.max(0, (clamped - rank.min) / BAND)),
  };
}
