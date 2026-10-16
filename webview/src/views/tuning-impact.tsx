// The results part of a tip card: a button to start tracking the tip, and
// once tracked, how its numbers moved compared with the weeks before, both
// overall and week by week.

import type { ReactElement } from 'react';

import type {
  ImpactDirection,
  ImpactFormat,
  ImpactMetric,
  ImpactVerdict,
  TipImpact,
} from '../../../src/shared/tuning.js';
import { Badge } from '../components/badge.js';
import { formatCompact, formatCost, formatDateTime, formatPercent } from '../format.js';
import type { Tone } from '../labels.js';
import { usePostAction } from '../vscode-context.js';

export const VERDICT_INFO: Readonly<Record<ImpactVerdict, { label: string; tone: Tone }>> = {
  better: { label: 'Better', tone: 'good' },
  worse: { label: 'Worse', tone: 'critical' },
  mixed: { label: 'Mixed', tone: 'warning' },
  same: { label: 'No clear change', tone: 'info' },
  early: { label: 'Too early', tone: 'info' },
  'no-baseline': { label: 'Nothing to compare', tone: 'info' },
};

const DIRECTION_LABELS: Readonly<Record<ImpactDirection, string>> = {
  better: 'better',
  worse: 'worse',
  same: 'about the same',
};

export function formatImpactValue(value: number | null, format: ImpactFormat): string {
  if (value === null) {
    return 'n/a';
  }
  switch (format) {
    case 'tokens': {
      return formatCompact(value);
    }
    case 'usd': {
      return formatCost(value);
    }
    case 'percent': {
      return formatPercent(value);
    }
    case 'per100': {
      return value.toFixed(1);
    }
  }
}

/** "-42%, better", or "new, worse" when it went up from nothing. */
export function formatChange(metric: ImpactMetric): string {
  if (metric.direction === null) {
    return 'n/a';
  }
  const label = DIRECTION_LABELS[metric.direction];
  if (metric.change === null) {
    return `up from none, ${label}`;
  }
  const sign = metric.change > 0 ? '+' : '';
  return `${sign}${formatPercent(metric.change)}, ${label}`;
}

function roleLabel(metric: ImpactMetric): string {
  if (metric.role === 'target') {
    return 'What the tip is about';
  }
  return metric.role === 'cost' ? 'Overall cost' : `Side effect: ${metric.why}`;
}

function MetricTable(props: { readonly impact: TipImpact; readonly label: string }): ReactElement {
  return (
    <table className="grid" aria-label={props.label}>
      <thead>
        <tr>
          <th scope="col">Measure</th>
          <th scope="col" className="num">
            30 days before
          </th>
          <th scope="col" className="num">
            Since
          </th>
          <th scope="col" className="num">
            Change
          </th>
        </tr>
      </thead>
      <tbody>
        {props.impact.metrics.map((metric) => (
          <tr key={metric.id}>
            <th scope="row" className="wrap" title={roleLabel(metric)}>
              {metric.role === 'target' ? <strong>{metric.label}</strong> : metric.label}
            </th>
            <td className="num">{formatImpactValue(metric.before, metric.format)}</td>
            <td className="num">{formatImpactValue(metric.after, metric.format)}</td>
            <td className={`num impact-${metric.direction ?? 'none'}`}>{formatChange(metric)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WeekTable(props: { readonly impact: TipImpact }): ReactElement {
  const { metrics, weeks } = props.impact;
  return (
    <details>
      <summary>Week by week</summary>
      <table className="grid" aria-label="Week by week">
        <thead>
          <tr>
            <th scope="col">Week from</th>
            <th scope="col" className="num">
              Sessions
            </th>
            {metrics.map((metric) => (
              <th key={metric.id} scope="col" className="num wrap">
                {metric.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">30 days before</th>
            <td className="num">{props.impact.sessionsBefore.toLocaleString('en-US')}</td>
            {metrics.map((metric) => (
              <td key={metric.id} className="num">
                {formatImpactValue(metric.before, metric.format)}
              </td>
            ))}
          </tr>
          {weeks.map((week) => (
            <tr key={week.start}>
              <th scope="row">{formatDateTime(week.start)}</th>
              <td className="num">{week.sessions.toLocaleString('en-US')}</td>
              {metrics.map((metric, index) => (
                <td key={metric.id} className="num">
                  {formatImpactValue(week.values[index] ?? null, metric.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function TipResults(props: {
  readonly tipId: string;
  readonly impact: TipImpact | null;
}): ReactElement {
  const post = usePostAction();
  const { impact } = props;
  const headingId = `tip-${props.tipId}-results`;
  if (impact === null) {
    return (
      <section className="tip-impact" aria-labelledby={headingId}>
        <h4 id={headingId}>Results</h4>
        <p className="muted">
          Taking this advice? Track it, and the sessions you start from now on are compared with the
          ones from the 30 days before, cost and side effects included. Setting a knob or creating a
          skill or agent this tip names from Overlord starts tracking on its own.
        </p>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              post({ type: 'trackTip', tipId: props.tipId, on: true });
            }}
          >
            Track from now
          </button>
        </div>
      </section>
    );
  }
  const verdict = VERDICT_INFO[impact.verdict];
  const compared = impact.verdict !== 'early' && impact.verdict !== 'no-baseline';
  return (
    <section className="tip-impact" aria-labelledby={headingId}>
      <header className="tip-header">
        <h4 id={headingId}>Results since {formatDateTime(impact.trackedSince)}</h4>
        <Badge label={verdict.label} tone={verdict.tone} />
      </header>
      <p>{impact.summary}</p>
      {compared ? <MetricTable impact={impact} label="Before and since" /> : null}
      {impact.sessionsAfter > 0 ? <WeekTable impact={impact} /> : null}
      <p className="muted">
        Lower is better for every measure. The work and the model change too, so a move under 10%
        counts as no change. Sessions already running when tracking started are left out.
      </p>
      <div className="actions">
        <button
          type="button"
          onClick={() => {
            post({ type: 'trackTip', tipId: props.tipId, on: false });
          }}
        >
          Stop tracking
        </button>
      </div>
    </section>
  );
}
