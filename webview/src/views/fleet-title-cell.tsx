// The title cell of a Fleet row: the twisty, where the session runs, its
// title and its badges, with the folder and what it is working on.

import type { ReactElement } from 'react';

import type { HealthLevel } from '../../../src/shared/health.js';
import { Badge, PlaceMarker, WindowlessMarker } from '../components/badge.js';
import type { Tone } from '../labels.js';

import type { RowEvent } from './fleet-actions.js';
import type { FleetRow, VisibleRow } from './fleet-rows.js';
import { isWindowless } from './windowless.js';

function Twisty(props: {
  readonly visible: VisibleRow;
  readonly onToggle: (visible: VisibleRow) => void;
}): ReactElement {
  const { visible, onToggle } = props;
  if (!visible.hasChildren) {
    return <span className="twisty" aria-hidden="true" />;
  }
  const verb = visible.expanded ? 'Collapse' : 'Expand';
  return (
    <button
      type="button"
      className="twisty"
      tabIndex={-1}
      data-tip={`${verb}: ${visible.expanded ? 'Hide' : 'Show'} the rows under this one`}
      aria-label={`${verb} ${visible.row.title}`}
      onClick={() => {
        onToggle(visible);
      }}
    >
      {visible.expanded ? '▾' : '▸'}
    </button>
  );
}

const HEALTH_BADGES: Readonly<
  Record<Exclude<HealthLevel, 'good'>, { readonly label: string; readonly tone: Tone }>
> = {
  watch: { label: 'Watch', tone: 'warning' },
  degraded: { label: 'Degraded', tone: 'critical' },
};

/** How worn out a session is, as a badge that opens its Session Properties. */
function HealthBadge(props: {
  readonly row: FleetRow;
  readonly tabIndex: number;
  readonly onAction: (row: FleetRow, action: RowEvent) => void;
}): ReactElement | null {
  const { row } = props;
  if (row.health === null) {
    return null;
  }
  const badge = HEALTH_BADGES[row.health];
  return (
    <button
      type="button"
      className={`badge badge-${badge.tone} health-badge`}
      tabIndex={props.tabIndex}
      data-tip={`Health: ${badge.label}. Open Session Properties to see why and what to do`}
      aria-label={`Health ${badge.label} for ${row.title}: open Session Properties`}
      onClick={() => {
        props.onAction(row, 'properties');
      }}
    >
      {badge.label}
    </button>
  );
}

export function TitleCell(props: {
  readonly visible: VisibleRow;
  readonly showSummary: boolean;
  readonly tabIndex: number;
  readonly onToggle: (visible: VisibleRow) => void;
  readonly onAction: (row: FleetRow, action: RowEvent) => void;
}): ReactElement {
  const { visible } = props;
  const { row } = visible;
  return (
    <td role="gridcell" className="col-title" data-tip={row.detail}>
      <span style={{ paddingLeft: `${(visible.depth * 1.2).toString()}em` }}>
        <Twisty visible={visible} onToggle={props.onToggle} />
        {row.place === null ? null : <PlaceMarker place={row.place} />}
        {isWindowless(row) ? <WindowlessMarker /> : null}
        <span className="row-title">{row.title}</span>
      </span>{' '}
      {row.kind === 'session' && row.needsProject ? (
        <Badge
          label="No project"
          tone="warning"
          title="Move to project puts this folder in one, or tells Overlord never to ask"
        />
      ) : null}{' '}
      <HealthBadge row={row} tabIndex={props.tabIndex} onAction={props.onAction} />{' '}
      <span className="muted row-detail">{row.detail}</span>
      {row.summary === null || !props.showSummary ? null : (
        <span
          className="muted row-summary"
          style={{ paddingLeft: `${(visible.depth * 1.2 + 1.2).toString()}em` }}
          data-tip={row.summary}
        >
          {row.summary}
        </span>
      )}
    </td>
  );
}
