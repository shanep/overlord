import type { ReactElement } from 'react';

export function EmptyState(props: {
  readonly title: string;
  readonly detail?: string;
}): ReactElement {
  return (
    <div className="empty" role="status">
      <p className="empty-title">{props.title}</p>
      {props.detail === undefined ? null : <p className="muted">{props.detail}</p>}
    </div>
  );
}
