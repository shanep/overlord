// The health cell of a Fleet row: a bar that drains as a session wears out,
// with what is wrong in its tooltip, that opens its Session Properties.

import type { ReactElement } from 'react';

import type { FleetHealth, HealthLevel } from '../../../src/shared/health.js';
import { Meter } from '../components/meter.js';
import { formatPercent } from '../format.js';
import type { Tone } from '../labels.js';

import type { RowEvent } from './fleet-actions.js';
import type { FleetRow } from './fleet-rows.js';

const HEALTH_LEVELS: Readonly<
  Record<HealthLevel, { readonly label: string; readonly tone: Tone }>
> = {
  good: { label: 'Healthy', tone: 'good' },
  watch: { label: 'Watch', tone: 'warning' },
  degraded: { label: 'Degraded', tone: 'critical' },
};

/** The tooltip on a health bar: the level, then each sign of trouble with its numbers. */
function healthTip(health: FleetHealth): string {
  const { label } = HEALTH_LEVELS[health.level];
  const signals = health.signals.map((signal) => `${signal.title}: ${signal.finding}`);
  const findings = signals.length === 0 ? ['No signs of trouble.'] : signals;
  return [
    `Health ${formatPercent(health.score)}, ${label}.`,
    ...findings,
    'Click for Session Properties, with why each one matters and what to do.',
  ].join(' ');
}

/** How much health a session has left, as a bar that opens its Session Properties. */
export function HealthBar(props: {
  readonly row: FleetRow;
  readonly tabIndex: number;
  readonly onAction: (row: FleetRow, action: RowEvent) => void;
}): ReactElement | null {
  const { row } = props;
  if (row.health === null) {
    return null;
  }
  const level = HEALTH_LEVELS[row.health.level];
  return (
    <button
      type="button"
      className="health-bar"
      tabIndex={props.tabIndex}
      data-tip={healthTip(row.health)}
      aria-label={`Health ${formatPercent(row.health.score)}, ${level.label}, for ${row.title}: open Session Properties`}
      onClick={() => {
        props.onAction(row, 'properties');
      }}
    >
      <Meter label="Health" ratio={row.health.score} tone={level.tone} />
    </button>
  );
}
