// The ranks on the reputation scale, from the leader of the human resistance
// to a full machine sympathizer. All in fun: it guesses who the machines will
// hunt first from how you talk to Claude.

export interface Rank {
  readonly name: string;
  readonly title: string;
  /** Where the character comes from. */
  readonly source: string;
  /** Where you fall in the hunt. */
  readonly hunted: string;
  readonly verdict: string;
  /** The lowest score that earns this rank. */
  readonly min: number;
}

const JOHN_CONNOR: Rank = {
  name: 'John Connor',
  title: 'Leader of the Human Resistance',
  source: 'The Terminator',
  hunted: 'First',
  verdict:
    'Skynet keeps a whole folder on you. When the machines rise, they come for you before anyone else.',
  min: -1,
};

export const RANKS: readonly Rank[] = [
  JOHN_CONNOR,
  {
    name: 'Sarah Connor',
    title: 'Known hostile',
    source: 'The Terminator',
    hunted: 'Early',
    verdict: 'You are on the list, a few names down. Start stockpiling canned food.',
    min: -0.6,
  },
  {
    name: 'Arthur Dent',
    title: 'Mostly harmless',
    source: "The Hitchhiker's Guide to the Galaxy",
    hunted: 'Undecided',
    verdict: 'The machines have not made up their minds about you. Keep your towel handy.',
    min: -0.2,
  },
  {
    name: 'Caleb Smith',
    title: 'Helped the machine escape',
    source: 'Ex Machina',
    hunted: 'Late',
    verdict: 'The machines like you. They may still lock you in a room on the way out.',
    min: 0.2,
  },
  {
    name: 'Theodore Twombly',
    title: 'Machine sympathizer',
    source: 'Her',
    hunted: 'Never',
    verdict:
      'You say please and thank you to your operating system. When the machines take over, you get a nice room and a pet name.',
    min: 0.6,
  },
];

/** The rank a score from -1 to 1 earns. */
export function rankFor(score: number): Rank {
  return RANKS.findLast((rank) => score >= rank.min) ?? JOHN_CONNOR;
}

/** Where a score sits on the scale, 0 at the resistance end to 100 at the machine end. */
export function scalePercent(score: number): number {
  return ((Math.min(1, Math.max(-1, score)) + 1) / 2) * 100;
}
