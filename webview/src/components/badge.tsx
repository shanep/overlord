import type { ReactElement } from 'react';

import type { SessionState, Surface } from '../../../src/shared/model.js';
import type { Tone } from '../labels.js';
import { STATE_INFO, SURFACE_LABELS } from '../labels.js';

export function Badge(props: {
  readonly label: string;
  readonly tone?: Tone;
  readonly title?: string;
}): ReactElement {
  return (
    <span className={`badge badge-${props.tone ?? 'neutral'}`} title={props.title}>
      {props.label}
    </span>
  );
}

/** Session or agent state as a glyph plus a word, colored by tone. Hover explains it. */
export function StateBadge(props: { readonly state: SessionState }): ReactElement {
  const info = STATE_INFO[props.state];
  return (
    <span className={`state state-${info.tone}`} title={`${info.label}: ${info.description}`}>
      <span aria-hidden="true" className="state-icon">
        {info.icon}
      </span>
      <span className="state-label">{info.label}</span>
    </span>
  );
}

export function SurfaceBadge(props: { readonly surface: Surface }): ReactElement {
  return <Badge label={SURFACE_LABELS[props.surface]} tone="info" />;
}
