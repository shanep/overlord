// Advice on working better with Claude Code, from measuring every session
// transcript: where the context and the money go, the habits that waste
// them, and skills or agents that would take the repetitive work over.

import type { ReactElement } from 'react';
import { useMemo } from 'react';

import type { TuningState } from '../../../src/shared/tuning.js';
import { useNow } from '../clock.js';
import { formatAgo, formatCompact, formatCost, formatDateTime, formatPercent } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import { SuggestionList, TipList, TuningSessionTable } from './tuning-lists.js';

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
    return (
      <span className="muted">
        Not scanned yet. The first scan reads every transcript and can take a minute.
      </span>
    );
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

export function TuningView(props: { readonly state: TuningState }): ReactElement {
  const { state } = props;
  const post = usePostAction();
  const names = useMemo(
    () => new Map(state.suggestions.map((suggestion) => [suggestion.id, suggestion.name])),
    [state.suggestions],
  );
  const titles = useMemo(() => new Map(state.tips.map((tip) => [tip.id, tip.title])), [state.tips]);
  const reread = state.totalUsd === 0 ? null : state.cacheReadUsd / state.totalUsd;
  return (
    <section aria-labelledby="tuning-title">
      <header className="view-header">
        <h1 id="tuning-title">Tuning</h1>
        <dl className="stats">
          <Stat label="Sessions" value={state.sessions.toLocaleString('en-US')} />
          <Stat label="Spend" value={formatCost(state.totalUsd)} />
          <Stat label="Re-reading context" value={formatPercent(reread)} />
          <Stat label="Average context" value={formatCompact(state.averageContext)} />
          <Stat label="Largest context" value={formatCompact(state.largestContext)} />
        </dl>
      </header>
      <div className="toolbar">
        <button
          type="button"
          onClick={() => {
            post({ type: 'rescanTuning' });
          }}
        >
          Rescan
        </button>
        <LastScanned at={state.scannedAt} />
      </div>
      <p className="muted">
        Advice from measuring every session transcript on this machine: how large the context got,
        what the spend went to, and habits that waste tokens. Costs are estimates at list price.
        Context counts are tokens sent with each request.
      </p>
      <TipList tips={state.tips} names={names} />
      <SuggestionList suggestions={state.suggestions} />
      <TuningSessionTable rows={state.rows} titles={titles} />
    </section>
  );
}
