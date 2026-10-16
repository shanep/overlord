// How often prompts held swearing, insults or frustrated phrases, aimed at
// Claude or in general. The counts come from an index the host keeps, so
// they include sessions whose transcripts Claude Code has since deleted.

import type { ReactElement } from 'react';
import { useMemo } from 'react';

import type { FrustrationState } from '../../../src/shared/protocol.js';
import { useChartTheme } from '../charts/chart-theme.js';
import { useNow } from '../clock.js';
import { ChartFigure } from '../components/chart-figure.js';
import { formatAgo, formatDateTime, formatInteger } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import { buildFrustrationChart, dayTable, formatShare } from './frustration-chart.js';
import { RecentHits, SessionTable, TopTerms } from './frustration-lists.js';

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

export function FrustrationView(props: { readonly state: FrustrationState }): ReactElement {
  const { state } = props;
  const post = usePostAction();
  const theme = useChartTheme();
  const chart = useMemo(() => buildFrustrationChart(state.byDay, theme), [state.byDay, theme]);
  const titles = useMemo(
    () => new Map(state.bySession.map((row) => [row.sessionId, row.title])),
    [state.bySession],
  );
  const hits = state.atClaude + state.general;
  return (
    <section aria-labelledby="frustration-title">
      <header className="view-header">
        <h1 id="frustration-title">Frustration</h1>
        <dl className="stats">
          <Stat label="Aimed at Claude" value={formatInteger(state.atClaude)} />
          <Stat label="General" value={formatInteger(state.general)} />
          <Stat label="Share of prompts" value={formatShare(hits, state.totalPrompts)} />
          <Stat label="Prompts counted" value={formatInteger(state.totalPrompts)} />
        </dl>
      </header>
      <div className="toolbar">
        <button
          type="button"
          onClick={() => {
            post({ type: 'rescanFrustration' });
          }}
        >
          Rescan
        </button>
        <LastScanned at={state.scannedAt} />
      </div>
      <p className="muted">
        Prompts you typed that hold swearing, insults or frustrated phrases. A prompt counts as
        aimed at Claude when it says you or calls names. Code, pasted text and quotes are left out.
        Counts are kept after Claude Code deletes old transcripts.
      </p>
      <div className="charts">
        <ChartFigure
          title="Prompts with hits by day"
          option={chart}
          height={220}
          table={dayTable(state.byDay)}
        />
      </div>
      <div className="columns">
        <TopTerms terms={state.topTerms} />
        <RecentHits hits={state.recent} titles={titles} />
      </div>
      <SessionTable rows={state.bySession} />
    </section>
  );
}
