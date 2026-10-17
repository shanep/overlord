// The title cell of a Fleet row: the twisty, where the session runs, its
// title and its badges, with the folder and what it is working on.

import type { ReactElement } from 'react';

import type { AgentInfo } from '../../../src/shared/agents.js';
import type { Backend } from '../../../src/shared/backends.js';
import {
  AgentMark,
  BackendMark,
  Badge,
  LaunchedMarker,
  PlaceMarker,
  WindowlessMarker,
} from '../components/badge.js';

import type { VisibleRow } from './fleet-rows.js';
import { isLaunched } from './launched.js';
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

/** The agent and its backend logo, or the logo alone when rows do not name their agent. */
function RowMark(props: {
  readonly agent: AgentInfo | null;
  readonly backend: Backend | null;
}): ReactElement | null {
  if (props.agent !== null) {
    return <AgentMark agent={props.agent} backend={props.backend} />;
  }
  return props.backend === null ? null : <BackendMark backend={props.backend} />;
}

export function TitleCell(props: {
  readonly visible: VisibleRow;
  /** The agent to name in front of the title, or null to leave it out. */
  readonly agent: AgentInfo | null;
  /** The backend logo to show in front of the title, or null (the default) for none. */
  readonly backend?: Backend | null;
  readonly showSummary: boolean;
  readonly onToggle: (visible: VisibleRow) => void;
}): ReactElement {
  const { visible, backend = null } = props;
  const { row } = visible;
  return (
    <td role="gridcell" className="col-title" data-tip={row.detail}>
      <span style={{ paddingLeft: `${(visible.depth * 1.2).toString()}em` }}>
        <Twisty visible={visible} onToggle={props.onToggle} />
        {isLaunched(row) ? <LaunchedMarker /> : null}
        {row.place === null ? null : <PlaceMarker place={row.place} />}
        {isWindowless(row) ? <WindowlessMarker /> : null}
        <RowMark agent={props.agent} backend={backend} />
        <span className="row-title">{row.title}</span>
      </span>{' '}
      {row.kind === 'session' && row.needsProject ? (
        <Badge
          label="No project"
          tone="warning"
          title="Move to project puts this folder in one, or tells Overlord never to ask"
        />
      ) : null}{' '}
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
