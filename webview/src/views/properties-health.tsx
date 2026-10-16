// Session health in the properties panel: the numbers that show a session
// wearing out, and for each sign of trouble, why it matters and what to do.

import type { ReactElement } from 'react';

import type {
  HealthLevel,
  HealthMetrics,
  HealthSignal,
  SessionHealth,
} from '../../../src/shared/health.js';
import { Badge } from '../components/badge.js';
import { Meter } from '../components/meter.js';
import { formatCompact, formatPercent } from '../format.js';
import type { Tone } from '../labels.js';

import type { Row } from './props-group.js';
import { PropertyRows } from './props-group.js';

const LEVELS: Readonly<
  Record<HealthLevel, { readonly label: string; readonly tone: Tone; readonly summary: string }>
> = {
  good: { label: 'Healthy', tone: 'good', summary: 'No signs of trouble.' },
  watch: {
    label: 'Watch',
    tone: 'warning',
    summary: 'Starting to show strain. Worth acting on before it gets worse.',
  },
  degraded: {
    label: 'Degraded',
    tone: 'critical',
    summary: 'Likely working worse than it did earlier. Act on the items below.',
  },
};

function ContextValue(props: {
  readonly metrics: HealthMetrics;
  readonly level: HealthLevel;
}): ReactElement {
  const { contextTokens, contextWindow } = props.metrics;
  if (contextTokens === null || contextWindow === null) {
    return <span className="muted">n/a</span>;
  }
  return (
    <>
      <Meter
        label="Context window fill"
        ratio={contextTokens / contextWindow}
        tone={props.level === 'good' ? 'info' : LEVELS[props.level].tone}
      />{' '}
      <span className="muted">
        {formatCompact(contextTokens)} of {formatCompact(contextWindow)}
      </span>
    </>
  );
}

function metricRows(health: SessionHealth): readonly Row[] {
  const { metrics } = health;
  const contextLevel = health.signals.find((signal) => signal.id === 'context')?.level ?? 'good';
  return [
    ['Context', <ContextValue key="context" metrics={metrics} level={contextLevel} />],
    ['Compactions', metrics.compactions.toString()],
    ['Turns', metrics.turns.toString()],
    [
      'Recent tool errors',
      `${metrics.recentToolErrors.toString()} of ${metrics.recentToolCalls.toString()}`,
    ],
    ['Recent cache hits', formatPercent(metrics.recentCacheHit)],
  ];
}

function Signal(props: { readonly signal: HealthSignal }): ReactElement {
  const { signal } = props;
  const level = LEVELS[signal.level];
  return (
    <article className="health-signal" aria-label={signal.title}>
      <h3>
        <Badge label={level.label} tone={level.tone} /> {signal.title}
      </h3>
      <p>{signal.finding}</p>
      <p className="muted">{signal.why}</p>
      <ol aria-label={`What to do: ${signal.title}`}>
        {signal.actions.map((action) => (
          <li key={action}>{action}</li>
        ))}
      </ol>
    </article>
  );
}

export function HealthSection(props: { readonly health: SessionHealth }): ReactElement {
  const { health } = props;
  const level = LEVELS[health.level];
  return (
    <section className="props-group" aria-label="Health">
      <h2>
        Health <Badge label={level.label} tone={level.tone} />
      </h2>
      <p className="health-summary">{level.summary}</p>
      <PropertyRows rows={metricRows(health)} />
      {health.signals.map((signal) => (
        <Signal key={signal.id} signal={signal} />
      ))}
    </section>
  );
}
