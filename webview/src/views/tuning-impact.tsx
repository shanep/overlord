// The results part of a tip card: a button to start tracking the tip, and
// once tracked, one line per measure with how it moved against the weeks
// before, and the week by week numbers behind a disclosure.

import type { ReactElement } from 'react';

import type {
  ImpactDirection,
  ImpactFormat,
  ImpactMetric,
  ImpactVerdict,
  TipImpact,
} from '../../../src/shared/tuning.js';
import { formatCompact, formatDateTime, formatPercent, formatUsd } from '../format.js';
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
      // The view says once that costs are estimates, so the rows stay short.
      return formatUsd(value);
    }
    case 'percent': {
      return formatPercent(value);
    }
    case 'per100': {
      return value.toFixed(1);
    }
  }
}

/** "-42%", "+8%", or "new" when it went up from nothing. */
export function formatChange(metric: ImpactMetric): string {
  if (metric.direction === null) {
    return 'n/a';
  }
  if (metric.change === null) {
    return 'new';
  }
  const sign = metric.change > 0 ? '+' : '';
  return `${sign}${formatPercent(metric.change)}`;
}

/** What a measure is there for, shown when you hover it. */
function roleLabel(metric: ImpactMetric): string {
  if (metric.role === 'target') {
    return 'What the tip is about';
  }
  return metric.role === 'cost' ? 'Overall cost' : `Side effect: ${metric.why}`;
}

function MetricList(props: { readonly impact: TipImpact }): ReactElement {
  return (
    <ul className="impact-metrics" aria-label="Before and since">
      {props.impact.metrics.map((metric) => (
        <li key={metric.id} className={`impact-${metric.role}`} title={roleLabel(metric)}>
          <span className="impact-label">{metric.label}</span>
          <span className="impact-values">
            {formatImpactValue(metric.before, metric.format)} →{' '}
            {formatImpactValue(metric.after, metric.format)}
          </span>
          <span className={`impact-change impact-${metric.direction ?? 'none'}`}>
            {formatChange(metric)}
            {metric.direction === null ? null : (
              <span className="visually-hidden">, {DIRECTION_LABELS[metric.direction]}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "10-16" for a week starting on October 16, short enough for a column. */
function weekLabel(start: number): string {
  return formatDateTime(start).slice(5, 10);
}

/** One row per measure and one column per week, so long labels sit where there is room. */
function WeekTable(props: { readonly impact: TipImpact }): ReactElement {
  const { metrics, weeks } = props.impact;
  return (
    <details>
      <summary>Week by week</summary>
      <div className="table-scroll">
        <table className="grid" aria-label="Week by week">
          <thead>
            <tr>
              <th scope="col">Week from</th>
              <th scope="col" className="num">
                Before
              </th>
              {weeks.map((week) => (
                <th key={week.start} scope="col" className="num" title={formatDateTime(week.start)}>
                  {weekLabel(week.start)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Sessions</th>
              <td className="num">{props.impact.sessionsBefore.toLocaleString('en-US')}</td>
              {weeks.map((week) => (
                <td key={week.start} className="num">
                  {week.sessions.toLocaleString('en-US')}
                </td>
              ))}
            </tr>
            {metrics.map((metric, index) => (
              <tr key={metric.id}>
                <th scope="row" className="wrap">
                  {metric.label}
                </th>
                <td className="num">{formatImpactValue(metric.before, metric.format)}</td>
                {weeks.map((week) => (
                  <td key={week.start} className="num">
                    {formatImpactValue(week.values[index] ?? null, metric.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function TrackButton(props: { readonly tipId: string; readonly on: boolean }): ReactElement {
  const post = usePostAction();
  return (
    <button
      type="button"
      className={props.on ? undefined : 'link-button'}
      title={
        props.on
          ? 'Compare the sessions you start from now on with the 30 days before'
          : 'Stop comparing and forget when tracking started'
      }
      onClick={() => {
        post({ type: 'trackTip', tipId: props.tipId, on: props.on });
      }}
    >
      {props.on ? 'Track from now' : 'Stop tracking'}
    </button>
  );
}

export function TipResults(props: {
  readonly tipId: string;
  readonly impact: TipImpact | null;
}): ReactElement {
  const { impact } = props;
  const headingId = `tip-${props.tipId}-results`;
  if (impact === null) {
    return (
      <div className="tip-impact actions">
        <TrackButton tipId={props.tipId} on />
      </div>
    );
  }
  const compared = impact.verdict !== 'early' && impact.verdict !== 'no-baseline';
  return (
    <section className="tip-impact" aria-labelledby={headingId}>
      <div className="impact-caption">
        <h4 id={headingId}>
          Since {formatDateTime(impact.trackedSince)}
          <span className="muted">
            {' '}
            {impact.sessionsAfter.toLocaleString('en-US')} sessions,{' '}
            {impact.sessionsBefore.toLocaleString('en-US')} before
          </span>
        </h4>
        <TrackButton tipId={props.tipId} on={false} />
      </div>
      {compared ? <MetricList impact={impact} /> : <p className="hint">{impact.summary}</p>}
      {impact.sessionsAfter > 0 ? <WeekTable impact={impact} /> : null}
    </section>
  );
}
