// The session limit part of the Tuning view: how full the plan's windows are,
// whether they last at the pace so far, which sessions used the current one,
// and what would make them last longer.

import type { ReactElement } from 'react';

import type {
  LimitLever,
  LimitSession,
  LimitState,
  LimitWindow,
} from '../../../src/shared/tuning.js';
import { useNow } from '../clock.js';
import { Badge } from '../components/badge.js';
import { Card, CardGrid, Notice, StatusDot, cardClassName } from '../components/card.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { Meter } from '../components/meter.js';
import { formatCost, formatDateTime, formatDuration, formatPercent } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import { severityTone } from './usage-view.js';

/** 3:40 PM: the hour and minute, which is all a five hour window needs. */
function timeOfDay(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "Resets in 2h 10m", and whether the pace so far gets there. */
function PaceLine(props: { readonly window: LimitWindow }): ReactElement {
  const { window } = props;
  if (window.percent >= 100) {
    return <span className="card-text">Used up until it resets.</span>;
  }
  if (window.runsOutAt === null || window.resetsAt === null) {
    return <span className="card-text">At this pace it lasts until the reset.</span>;
  }
  const early = formatDuration(window.resetsAt - window.runsOutAt);
  return (
    <span className="card-text" title={formatDateTime(window.runsOutAt)}>
      {`At this pace it runs out at ${timeOfDay(window.runsOutAt)}, ${early} before the reset.`}
    </span>
  );
}

function WindowCard(props: { readonly window: LimitWindow }): ReactElement {
  const { window } = props;
  const now = useNow();
  const tone = severityTone(window.severity);
  return (
    <Card tone={tone}>
      <div className="card-head">
        <StatusDot tone={tone} />
        <span className="card-title">{window.label}</span>
        {window.runsOutAt === null ? null : <Badge label="Runs out early" tone="warning" />}
      </div>
      <Meter label={`${window.label} used`} ratio={window.percent / 100} tone={tone} />
      {window.resetsAt === null ? null : (
        <span className="card-sub" title={formatDateTime(window.resetsAt)}>
          {`Resets in ${formatDuration(Math.max(0, window.resetsAt - now))}`}
        </span>
      )}
      <PaceLine window={window} />
    </Card>
  );
}

function SessionTitle(props: { readonly session: LimitSession }): ReactElement {
  const post = usePostAction();
  const { session } = props;
  return (
    <button
      type="button"
      className="link-button"
      title="Open the agent view for this session"
      onClick={() => {
        post({ type: 'openAgent', sessionId: session.sessionId, agentId: session.sessionId });
      }}
    >
      {session.title}
    </button>
  );
}

const SESSION_COLUMNS: readonly Column<LimitSession>[] = [
  {
    id: 'title',
    header: 'Session',
    cell: (row) => <SessionTitle session={row} />,
    wrap: true,
  },
  {
    id: 'share',
    header: 'Share',
    cell: (row) => <Meter label={`${row.title} share`} ratio={row.share} tone="info" />,
  },
  {
    id: 'spend',
    header: 'Spend',
    cell: (row) => formatCost(row.usd),
    numeric: true,
    drop: 1,
  },
];

/** 1.3x for a 23% saving: the limit stretches by 1 / (1 - saving). */
export function stretchOf(saving: number): string {
  const factor = 1 / (1 - Math.min(saving, 0.95));
  return `${factor.toFixed(1)}x`;
}

function LeverCard(props: {
  readonly lever: LimitLever;
  readonly tips: ReadonlyMap<string, string>;
}): ReactElement {
  const { lever } = props;
  const headingId = `lever-${lever.id}`;
  const tip = lever.tipId === null ? undefined : props.tips.get(lever.tipId);
  return (
    <article className={cardClassName({ tone: 'info', extra: 'tip' })} aria-labelledby={headingId}>
      <header className="tip-header">
        <StatusDot tone="info" />
        <h3 id={headingId}>{lever.title}</h3>
        <Badge label={`Saves about ${formatPercent(lever.saving)}`} tone="info" />
      </header>
      <p>{lever.finding}</p>
      <p className="muted">{`The same limit would last about ${stretchOf(lever.saving)} as long.`}</p>
      <details>
        <summary>What to do</summary>
        <ul className="tip-advice">
          {lever.advice.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {tip === undefined ? null : <p className="muted">{`More in the advice below: ${tip}.`}</p>}
      </details>
    </article>
  );
}

export function LimitSection(props: {
  readonly limit: LimitState;
  readonly tips: ReadonlyMap<string, string>;
}): ReactElement {
  const { limit } = props;
  const plan = limit.subscription === null ? '' : ` (${limit.subscription})`;
  const since = limit.windows.some((window) => window.kind === 'session')
    ? `since this window opened at ${timeOfDay(limit.windowStart)}`
    : 'in the last five hours';
  return (
    <section className="card-group limit" aria-labelledby="tuning-limit">
      <h2 id="tuning-limit">{`Session limit${plan}`}</h2>
      {limit.windows.length === 0 ? (
        <p className="empty-line">
          Overlord could not read your plan limits, so this shows spend only. Plan limits apply when
          Claude Code is signed in with a Pro, Max, Team or Enterprise plan.
        </p>
      ) : (
        <CardGrid labelledBy="tuning-limit">
          {limit.windows.map((window) => (
            <WindowCard key={`${window.kind}:${window.label}`} window={window} />
          ))}
        </CardGrid>
      )}
      <h3 id="tuning-limit-sessions">
        What used it <span className="muted">{`${formatCost(limit.windowUsd)} ${since}`}</span>
      </h3>
      <div className="table-card">
        <DataTable
          caption="Sessions in the current window"
          columns={SESSION_COLUMNS}
          rows={limit.sessions}
          rowKey={(row) => row.sessionId}
          empty="Nothing has run in this window yet."
        />
      </div>
      <h3 id="tuning-limit-levers">
        Make it last longer{' '}
        <span className="muted">{`measured on ${formatCost(limit.weekUsd)} over the last 7 days`}</span>
      </h3>
      {limit.levers.length === 0 ? (
        <Notice ok>No habit stands out as using the limit up faster than it needs to.</Notice>
      ) : (
        <div className="card-grid card-grid-wide tips">
          {limit.levers.map((lever) => (
            <LeverCard key={lever.id} lever={lever} tips={props.tips} />
          ))}
        </div>
      )}
    </section>
  );
}
