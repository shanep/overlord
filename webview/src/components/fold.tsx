// A section folded away under its heading. Whether it is open is saved with
// the webview state, so a section you opened stays open when you come back.

import type { ReactElement, ReactNode } from 'react';

import { isBoolean } from '../guards.js';
import { usePersistentState } from '../vscode-context.js';

export function Fold(props: {
  /** The heading's id, which also names the saved open state. */
  readonly id: string;
  readonly title: string;
  /** A short muted note after the title, such as a count. */
  readonly note?: string;
  readonly children: ReactNode;
}): ReactElement {
  const [open, setOpen] = usePersistentState(`fold:${props.id}`, false, isBoolean);
  return (
    <section className="section" aria-labelledby={props.id}>
      <details
        className="fold"
        open={open}
        onToggle={(event) => {
          setOpen(event.currentTarget.open);
        }}
      >
        <summary>
          <h2 id={props.id}>{props.title}</h2>
          {props.note === undefined ? null : <span className="muted fold-note">{props.note}</span>}
        </summary>
        <div className="fold-body">{props.children}</div>
      </details>
    </section>
  );
}
