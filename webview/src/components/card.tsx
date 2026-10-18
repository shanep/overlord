// The card layout every view uses for a collection you scan rather than sort:
// a grid of cards, grouped under a heading with a count, with a status dot and
// a colored left edge for state. The webview-design skill says when to reach
// for these instead of a DataTable.

import type { ReactElement, ReactNode } from 'react';

import type { Tone } from '../labels.js';

/** How many avatar colors css/cards.css defines. */
const AVATAR_COLORS = 6;

/** A grid of cards. Wide fits fewer, larger cards and fills the gap an open card leaves. */
export function CardGrid(props: {
  readonly label?: string;
  readonly labelledBy?: string;
  readonly wide?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <ul
      className={props.wide === true ? 'card-grid card-grid-wide' : 'card-grid'}
      aria-label={props.label}
      aria-labelledby={props.labelledBy}
    >
      {props.children}
    </ul>
  );
}

/**
 * One card. A tone gives it a colored left edge, `action` highlights it on
 * hover when the card has buttons, and `open` stretches it across the row.
 */
export function Card(props: {
  readonly tone?: Tone;
  readonly action?: boolean;
  readonly open?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const classes = ['card'];
  if (props.tone !== undefined) {
    classes.push('card-edge', `card-${props.tone}`);
  }
  if (props.action === true) {
    classes.push('card-action');
  }
  if (props.open === true) {
    classes.push('card-open');
  }
  return <li className={classes.join(' ')}>{props.children}</li>;
}

/** A heading with a count over a grid of cards. Renders nothing when the group is empty. */
export function CardGroup(props: {
  readonly id: string;
  readonly title: string;
  readonly count: number;
  readonly wide?: boolean;
  readonly children: ReactNode;
}): ReactElement | null {
  if (props.count === 0) {
    return null;
  }
  return (
    <section className="card-group" aria-labelledby={props.id}>
      <h2 id={props.id}>
        {props.title} <span className="count">{String(props.count)}</span>
      </h2>
      <CardGrid labelledBy={props.id} wide={props.wide === true}>
        {props.children}
      </CardGrid>
    </section>
  );
}

/** A small colored dot for a state. Decorative: say the state in words too. */
export function StatusDot(props: { readonly tone: Tone }): ReactElement {
  return <span className={`status-dot status-dot-${props.tone}`} aria-hidden="true" />;
}

/** The same color for the same seed every time, so a grid is easy to scan. */
function avatarColor(seed: string): number {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 9973;
  }
  return hash % AVATAR_COLORS;
}

/** A colored tile with the first letter of the text. */
export function Avatar(props: { readonly seed: string; readonly text: string }): ReactElement {
  return (
    <span className={`avatar avatar-${String(avatarColor(props.seed))}`} aria-hidden="true">
      {props.text.slice(0, 1).toUpperCase()}
    </span>
  );
}

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** A row of joined toggle buttons, one pressed at a time, for a filter or a mode. */
export function Segmented<T extends string>(props: {
  readonly label: string;
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}): ReactElement {
  return (
    <div role="group" aria-label={props.label} className="segmented">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={props.value === option.value}
          onClick={() => {
            props.onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A one-line result with a colored left edge: what an action did, or why it did not. */
export function Notice(props: {
  readonly ok: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <p
      className={props.ok ? 'notice notice-good' : 'notice notice-critical'}
      role={props.ok ? 'status' : 'alert'}
    >
      {props.children}
    </p>
  );
}

/**
 * The classes a Card uses, for an element that has to be something other than
 * a list item, such as an article with its own heading.
 */
export function cardClassName(options: {
  readonly tone?: Tone | undefined;
  readonly action?: boolean;
  readonly extra?: string;
}): string {
  const classes = ['card'];
  if (options.tone !== undefined) {
    classes.push('card-edge', `card-${options.tone}`);
  }
  if (options.action === true) {
    classes.push('card-action');
  }
  if (options.extra !== undefined) {
    classes.push(options.extra);
  }
  return classes.join(' ');
}

/** A row of stat tiles: the few numbers a section is about, each big enough to read at a glance. */
export function StatTiles(props: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <dl className="tile-grid" aria-label={props.label}>
      {props.children}
    </dl>
  );
}

/** One stat tile: a label, a large value under it, and an optional line of detail. */
export function StatTile(props: {
  readonly label: string;
  readonly value: ReactNode;
  readonly detail?: ReactNode;
  readonly tone?: Tone | undefined;
  /** A hover note, such as the exact number behind a rounded one. */
  readonly title?: string | undefined;
}): ReactElement {
  return (
    <div className={cardClassName({ tone: props.tone, extra: 'tile' })} title={props.title}>
      <dt className="tile-label">{props.label}</dt>
      <dd className="tile-value">{props.value}</dd>
      {props.detail === undefined ? null : <dd className="tile-detail">{props.detail}</dd>}
    </div>
  );
}
