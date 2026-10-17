import type { ReactElement } from 'react';

import { formatPercent } from '../format.js';
import type { Tone } from '../labels.js';

/** Fill tone for a 0 to 1 ratio: accent, then warning past 70%, critical past 90%. */
export function meterTone(ratio: number): Tone {
  if (ratio >= 0.9) {
    return 'critical';
  }
  return ratio >= 0.7 ? 'warning' : 'info';
}

/** A thin horizontal bar for a 0 to 1 ratio, with the percent as text. */
export function Meter(props: {
  readonly label: string;
  readonly ratio: number | null;
  /** Overrides the fill tone, for values graded elsewhere. */
  readonly tone?: Tone;
  /** Overrides the percent shown beside the bar, such as 3/8. */
  readonly text?: string;
}): ReactElement {
  const { label, ratio } = props;
  if (ratio === null) {
    return <span className="muted">n/a</span>;
  }
  const clamped = Math.min(1, Math.max(0, ratio));
  const percent = Math.round(clamped * 100);
  return (
    <span className="meter-wrap">
      <span
        className="meter"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span
          className={`meter-fill meter-${props.tone ?? meterTone(clamped)}`}
          style={{ width: `${percent.toString()}%` }}
        />
      </span>
      <span className="meter-text">{props.text ?? formatPercent(clamped)}</span>
    </span>
  );
}
