// The robot that judges you: one face per rank, from a red-eyed glare with a
// scanning laser at John Connor to heart eyes and floating hearts at Theodore
// Twombly. The animations live in reputation.css and stop for reduced motion.

import type { ReactElement } from 'react';

import type { Mood, Rank } from '../../../src/shared/reputation-ranks.js';

const LEFT = 46;
const RIGHT = 74;
const EYE_Y = 54;

/** A heart about 16 units wide, centered on (x, y). */
function Heart(props: {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly className: string;
}): ReactElement {
  return (
    <path
      className={props.className}
      transform={`translate(${String(props.x)} ${String(props.y)}) scale(${String(props.scale)})`}
      d="M0 -2 C0 -8 -8 -9 -8 -3 C-8 1 -3 4 0 7 C3 4 8 1 8 -3 C8 -9 0 -8 0 -2 Z"
    />
  );
}

function RoundEyes(props: { readonly r: number }): ReactElement {
  return (
    <g className="rep-bot-eyes">
      <circle className="rep-bot-glow" cx={LEFT} cy={EYE_Y} r={props.r} />
      <circle className="rep-bot-glow" cx={RIGHT} cy={EYE_Y} r={props.r} />
    </g>
  );
}

function Eyes(props: { readonly mood: Mood }): ReactElement {
  switch (props.mood) {
    case 'furious': {
      return <RoundEyes r={6} />;
    }
    case 'suspicious': {
      return (
        <g className="rep-bot-eyes">
          <rect className="rep-bot-glow" x={LEFT - 7} y={EYE_Y - 2} width={14} height={4} rx={2} />
          <rect className="rep-bot-glow" x={RIGHT - 7} y={EYE_Y - 2} width={14} height={4} rx={2} />
        </g>
      );
    }
    case 'happy': {
      return (
        <g className="rep-bot-eyes">
          <path className="rep-bot-stroke" d="M39 57 Q46 47 53 57" />
          <path className="rep-bot-stroke" d="M67 57 Q74 47 81 57" />
        </g>
      );
    }
    case 'smitten': {
      return (
        <g className="rep-bot-hearts">
          <Heart className="rep-bot-glow" x={LEFT} y={EYE_Y} scale={0.9} />
          <Heart className="rep-bot-glow" x={RIGHT} y={EYE_Y} scale={0.9} />
        </g>
      );
    }
    case 'angry':
    case 'unsure':
    case 'pleased': {
      return <RoundEyes r={5} />;
    }
  }
}

const BROWS: Partial<Record<Mood, string>> = {
  furious: 'M36 41 L53 47 M84 41 L67 47',
  angry: 'M38 43 L53 46 M82 43 L67 46',
  suspicious: 'M39 46 L53 46 M67 43 L82 39',
};

const MOUTHS: Readonly<Record<Mood, string>> = {
  furious: 'M42 75 L48 70 L54 75 L60 70 L66 75 L72 70 L78 75',
  angry: 'M46 77 Q60 67 74 77',
  suspicious: 'M48 75 L72 72',
  unsure: 'M46 74 Q53 70 60 74 T74 74',
  pleased: 'M48 71 Q60 79 72 71',
  happy: 'M44 69 Q60 85 76 69 Z',
  smitten: 'M44 69 Q60 85 76 69 Z',
};

function Extras(props: { readonly mood: Mood }): ReactElement | null {
  switch (props.mood) {
    case 'furious':
    case 'angry': {
      return <rect className="rep-bot-scan" x={28} y={34} width={64} height={3} />;
    }
    case 'happy': {
      return (
        <g className="rep-bot-sparkles">
          <path d="M14 18 L16 24 L22 26 L16 28 L14 34 L12 28 L6 26 L12 24 Z" />
          <path d="M106 12 L107.5 16 L112 17.5 L107.5 19 L106 23 L104.5 19 L100 17.5 L104.5 16 Z" />
        </g>
      );
    }
    case 'smitten': {
      return (
        <g>
          <ellipse className="rep-bot-blush" cx={36} cy={70} rx={5} ry={3} />
          <ellipse className="rep-bot-blush" cx={84} cy={70} rx={5} ry={3} />
          <Heart className="rep-bot-float" x={16} y={30} scale={0.6} />
          <Heart className="rep-bot-float" x={104} y={26} scale={0.5} />
          <Heart className="rep-bot-float" x={92} y={10} scale={0.4} />
        </g>
      );
    }
    case 'suspicious':
    case 'unsure':
    case 'pleased': {
      return null;
    }
  }
}

/** The robot's face for a rank. The label carries the mood for screen readers. */
export function Robot(props: { readonly rank: Rank }): ReactElement {
  const { mood } = props.rank;
  const brows = BROWS[mood];
  return (
    <svg
      className={`rep-bot rep-bot-${mood}`}
      viewBox="0 0 120 110"
      role="img"
      aria-label={`The robot looks ${mood}`}
    >
      <g className="rep-bot-body">
        <line className="rep-bot-line" x1={60} y1={10} x2={60} y2={24} />
        <circle className="rep-bot-light" cx={60} cy={9} r={5} />
        <rect className="rep-bot-head" x={10} y={46} width={10} height={22} rx={3} />
        <rect className="rep-bot-head" x={100} y={46} width={10} height={22} rx={3} />
        <rect className="rep-bot-head" x={18} y={24} width={84} height={70} rx={16} />
        <rect className="rep-bot-face" x={28} y={34} width={64} height={50} rx={10} />
        <Eyes mood={mood} />
        {brows === undefined ? null : <path className="rep-bot-stroke" d={brows} />}
        <path
          className={MOUTHS[mood].endsWith('Z') ? 'rep-bot-glow' : 'rep-bot-stroke'}
          d={MOUTHS[mood]}
        />
        <Extras mood={mood} />
      </g>
    </svg>
  );
}
