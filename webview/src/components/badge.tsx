import type { ReactElement } from 'react';

import type { SessionPlace, SessionState, Surface } from '../../../src/shared/model.js';
import type { Tone } from '../labels.js';
import { PLACE_INFO, STATE_INFO, SURFACE_LABELS, WINDOWLESS_INFO } from '../labels.js';

import { Icon } from './icon.js';

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

/** Where a live session runs, as an icon. Hovering or a screen reader gives the words. */
export function PlaceMarker(props: { readonly place: SessionPlace }): ReactElement {
  const info = PLACE_INFO[props.place];
  return (
    <span
      className={`place place-${info.tone}`}
      role="img"
      aria-label={info.label}
      title={`${info.label}: ${info.description}`}
    >
      <Icon name={info.icon} />
    </span>
  );
}

/** A quiet session no terminal shows, which leaves the fleet in time. */
export function WindowlessMarker(): ReactElement {
  return (
    <span
      className="place place-neutral"
      role="img"
      aria-label={WINDOWLESS_INFO.label}
      title={`${WINDOWLESS_INFO.label}: ${WINDOWLESS_INFO.description}`}
    >
      <Icon name="hourglass" />
    </span>
  );
}
