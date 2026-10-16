// A titled group of label and value rows, like an IDE property sheet.

import type { ReactElement, ReactNode } from 'react';

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

export function Group(props: {
  readonly title: string;
  readonly rows: readonly Row[];
}): ReactElement {
  return (
    <section className="props-group" aria-label={props.title}>
      <h2>{props.title}</h2>
      <PropertyRows rows={props.rows} />
    </section>
  );
}
