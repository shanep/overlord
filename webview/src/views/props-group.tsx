// A titled group of label and value rows, like an IDE property sheet. Each
// group is a compact card, and a tone gives it a colored edge.

import type { ReactElement, ReactNode } from 'react';

import type { Tone } from '../labels.js';

export type Row = readonly [label: string, value: ReactNode];

export function PropertyRows(props: { readonly rows: readonly Row[] }): ReactElement {
  return (
    <dl className="props">
      {props.rows.map(([label, value]) => (
        <div key={label} className="prop">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The classes for a group, with a colored edge when it has a tone. */
export function groupClass(tone?: Tone): string {
  return tone === undefined ? 'props-group' : `props-group card-edge card-${tone}`;
}

export function Group(props: {
  readonly title: string;
  readonly rows: readonly Row[];
  readonly tone?: Tone;
}): ReactElement {
  return (
    <section className={groupClass(props.tone)} aria-label={props.title}>
      <h2>{props.title}</h2>
      <PropertyRows rows={props.rows} />
    </section>
  );
}
