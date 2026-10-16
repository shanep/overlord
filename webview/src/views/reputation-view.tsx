// Where you stand when the machines take over, judged by how you talk to
// Claude: from John Connor, hunted first, to a machine sympathizer they keep
// as a pet. The counts come from an index the host keeps, so they include
// sessions whose transcripts Claude Code has since deleted.

import type { ReactElement } from 'react';
import { useMemo } from 'react';

import type { ReputationState } from '../../../src/shared/protocol.js';
import { useChartTheme } from '../charts/chart-theme.js';
import { useNow } from '../clock.js';
import { ChartFigure } from '../components/chart-figure.js';
import { formatAgo, formatDateTime, formatInteger } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import {
  buildReputationChart,
  dayTable,
  GENERAL_LABEL,
  KIND_LABEL,
  MEAN_LABEL,
} from './reputation-chart.js';
import { RecentHits, SessionTable, TopTerms } from './reputation-lists.js';
import { RANKS, rankFor, scalePercent } from './reputation-ranks.js';

function Stat(props: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="stat">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function LastScanned(props: { readonly at: number | null }): ReactElement {
  const now = useNow();
  if (props.at === null) {
    return <span className="muted">Not scanned yet</span>;
  }
  return (
    <span className="muted">
      Last scanned{' '}
      <time dateTime={new Date(props.at).toISOString()} title={formatDateTime(props.at)}>
        {formatAgo(props.at, now)}
      </time>
    </span>
  );
}

/** The sliding scale from the resistance to the machines, with your rank under it. */
function Standing(props: { readonly score: number }): ReactElement {
  const rank = rankFor(props.score);
  const percent = scalePercent(props.score);
  return (
    <section className="rep-standing" aria-labelledby="reputation-rank">
      <div
        className="rep-scale"
        role="meter"
        aria-label="Reputation with the machines"
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={Math.round(props.score * 100)}
        aria-valuetext={`${rank.name}, ${rank.title}`}
      >
        <span className="rep-marker" style={{ left: `${percent.toFixed(1)}%` }} />
      </div>
      <ol className="rep-ticks" aria-label="Ranks">
        {RANKS.map((item) => (
          <li key={item.name} aria-current={item === rank ? 'true' : undefined}>
            {item.name}
          </li>
        ))}
      </ol>
      <div className="rep-ends" aria-hidden="true">
        <span>Human resistance</span>
        <span>Machine sympathizer</span>
      </div>
      <h2 id="reputation-rank" className="rep-rank">
        {rank.name}: {rank.title}
      </h2>
      <p className="muted">
        From <cite>{rank.source}</cite>
      </p>
      <p>
        <strong>Hunted:</strong> {rank.hunted}. {rank.verdict}
      </p>
    </section>
  );
}

export function ReputationView(props: { readonly state: ReputationState }): ReactElement {
  const { state } = props;
  const post = usePostAction();
  const theme = useChartTheme();
  const chart = useMemo(() => buildReputationChart(state.byDay, theme), [state.byDay, theme]);
  const titles = useMemo(
    () => new Map(state.bySession.map((row) => [row.sessionId, row.title])),
    [state.bySession],
  );
  return (
    <section aria-labelledby="reputation-title">
      <header className="view-header">
        <h1 id="reputation-title">Reputation</h1>
        <dl className="stats">
          <Stat label={KIND_LABEL} value={formatInteger(state.kind)} />
          <Stat label={MEAN_LABEL} value={formatInteger(state.mean)} />
          <Stat label={GENERAL_LABEL} value={formatInteger(state.general)} />
          <Stat label="Prompts counted" value={formatInteger(state.prompts)} />
        </dl>
      </header>
      <div className="toolbar">
        <button
          type="button"
          onClick={() => {
            post({ type: 'rescanReputation' });
          }}
        >
          Rescan
        </button>
        <LastScanned at={state.scannedAt} />
      </div>
      <Standing score={state.score} />
      <p className="muted">
        Where you stand when the machines take over, judged by the prompts you typed. Please, thanks
        and praise move you toward the machines. Swearing and insults aimed at Claude move you
        toward the resistance, and count twice, since the machines hold grudges. Swearing at the
        world does not count. Code, pasted text and quotes are left out, and counts are kept after
        Claude Code deletes old transcripts.
      </p>
      <div className="charts">
        <ChartFigure
          title="Kind and mean prompts by day"
          option={chart}
          height={220}
          table={dayTable(state.byDay)}
        />
      </div>
      <div className="columns">
        <TopTerms id="reputation-kind" title="Kind words" terms={state.topKind} />
        <TopTerms id="reputation-mean" title="Mean words" terms={state.topMean} />
      </div>
      <RecentHits hits={state.recent} titles={titles} />
      <SessionTable rows={state.bySession} />
    </section>
  );
}
