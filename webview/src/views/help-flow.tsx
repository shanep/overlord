// Boxes and arrows for the flow diagrams on the help page. They draw in theme
// colors, so the diagrams follow light, dark and high contrast themes.

import type { ReactElement, ReactNode } from 'react';

/** The border says what kind of step a box is: where it starts, a good end, a warning or a side path. */
export type Tone = 'plain' | 'start' | 'good' | 'warn' | 'side';

export interface BoxProps {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly title: string;
  /** Lines under the title. A line that starts with a backtick is a command, drawn in the code font. */
  readonly lines?: readonly string[];
  readonly tone?: Tone;
}

const TITLE_DROP = 22;
const LINE_HEIGHT = 17;

export function Box(props: BoxProps): ReactElement {
  const { x, y, w, h, title, lines = [], tone = 'plain' } = props;
  return (
    <g className={`flow-box flow-${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx="6" />
      <text className="flow-title" x={x + 12} y={y + TITLE_DROP}>
        {title}
      </text>
      {lines.map((line, index) => {
        const code = line.startsWith('`');
        return (
          <text
            key={line}
            className={code ? 'flow-code' : undefined}
            x={x + 12}
            y={y + TITLE_DROP + (index + 1) * LINE_HEIGHT + 2}
          >
            {code ? line.slice(1) : line}
          </text>
        );
      })}
    </g>
  );
}

interface ArrowLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly anchor?: 'start' | 'middle';
}

/** An arrow along a path, with an optional label. */
export function Arrow(props: {
  readonly head: string;
  readonly d: string;
  readonly dashed?: boolean;
  readonly label?: ArrowLabel;
}): ReactElement {
  const { head, d, dashed = false, label } = props;
  return (
    <>
      <path
        className={dashed ? 'flow-arrow flow-dashed' : 'flow-arrow'}
        d={d}
        markerEnd={`url(#${head})`}
      />
      {label === undefined ? null : (
        <text className="flow-label" x={label.x} y={label.y} textAnchor={label.anchor ?? 'middle'}>
          {label.text}
        </text>
      )}
    </>
  );
}

/** An SVG figure with an arrowhead marker named `head`, which its arrows use. */
export function Flow(props: {
  readonly head: string;
  readonly title: string;
  readonly description: string;
  readonly height: number;
  readonly children: ReactNode;
}): ReactElement {
  const titleId = `${props.head}-title`;
  const descId = `${props.head}-desc`;
  return (
    <svg
      className="flow"
      viewBox={`0 0 960 ${String(props.height)}`}
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
    >
      <title id={titleId}>{props.title}</title>
      <desc id={descId}>{props.description}</desc>
      <defs>
        <marker
          id={props.head}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path className="flow-head" d="M0 0L10 5L0 10z" />
        </marker>
      </defs>
      {props.children}
    </svg>
  );
}
