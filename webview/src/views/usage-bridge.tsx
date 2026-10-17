// The Usage view's Boise State section: this month's spend against the
// boisestate.ai quota, and the bridge's calls by day and by model, priced at
// boisestate.ai's rates.

import type { ReactElement } from 'react';

import type {
  BridgeQuota,
  BridgeUsage,
  BridgeUsageTotals,
} from '../../../src/shared/bridge-usage.js';
import { BOISESTATE_USAGE_URL } from '../../../src/shared/bridge-usage.js';
import { useNow } from '../clock.js';
import { cardClassName, StatTile, StatTiles, StatusDot } from '../components/card.js';
import { Meter } from '../components/meter.js';
import { formatCompact, formatDateTime, formatInteger } from '../format.js';
import type { Tone } from '../labels.js';

const COUNTED =
  "boisestate.ai shows usage only to a signed-in browser, so the bridge logs every call it makes with the token counts the backend reports, from Claude Code sessions, the Launcher and anything else that uses it, and prices them at boisestate.ai's rates. When the backend refuses a call for the quota, it says what it has counted, and the log keeps that too. None of it counts against a Claude plan.";

/** Days the bridge table lists, newest first. */
const BRIDGE_DAYS = 14;
const WEEK_MS = 7 * 24 * 60 * 60_000;

/** The local calendar day of an epoch ms, as YYYY-MM-DD like the bridge log's days. */
export function localDate(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The calls, input and output tokens of the bridge days on or after from. */
export function bridgeTotals(bridge: BridgeUsage, from = ''): BridgeUsageTotals {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const day of bridge.days) {
    if (day.date >= from) {
      calls += day.calls;
      inputTokens += day.inputTokens;
      outputTokens += day.outputTokens;
      costUsd += day.costUsd;
    }
  }
  return { calls, inputTokens, outputTokens, costUsd };
}

const tokens = (totals: BridgeUsageTotals): string =>
  formatCompact(totals.inputTokens + totals.outputTokens);

/** Dollars to the cent, or to the tenth of a cent below a dime so small calls still show. */
export function formatUsd(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.1 ? 3 : 2)}`;
}

const detail = (totals: BridgeUsageTotals): string =>
  `${formatInteger(totals.calls)} calls, ${formatUsd(totals.costUsd)}`;

function BridgeRows(props: {
  readonly caption: string;
  readonly first: string;
  readonly rows: readonly (BridgeUsageTotals & {
    readonly key: string;
    readonly priced?: boolean;
  })[];
}): ReactElement {
  return (
    <table className="grid">
      <caption className="visually-hidden">{props.caption}</caption>
      <thead>
        <tr>
          <th scope="col">{props.first}</th>
          <th scope="col" className="num">
            Calls
          </th>
          <th scope="col" className="num">
            Input tokens
          </th>
          <th scope="col" className="num">
            Output tokens
          </th>
          <th scope="col" className="num">
            Cost
          </th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr key={row.key}>
            <td>{row.key}</td>
            <td className="num">{formatInteger(row.calls)}</td>
            <td className="num">{formatCompact(row.inputTokens)}</td>
            <td className="num">{formatCompact(row.outputTokens)}</td>
            <td className="num">{row.priced === false ? 'no rate' : formatUsd(row.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Blue below 80%, yellow from 80%, red once the quota is used up. */
export function quotaTone(percent: number): Tone {
  if (percent >= 100) {
    return 'critical';
  }
  return percent >= 80 ? 'warning' : 'info';
}

/** Where this month's figure comes from, which says how far to trust it. */
function quotaSource(quota: BridgeQuota): string {
  return quota.reportedAt === null
    ? 'Logged through the bridge only. boisestate.ai web chat and use from before the log are not in it.'
    : `boisestate.ai's own figure from ${formatDateTime(quota.reportedAt)}, plus the calls logged since.`;
}

function QuotaCard(props: { readonly quota: BridgeQuota }): ReactElement {
  const { quota } = props;
  const percent = quota.limitUsd <= 0 ? 0 : (quota.spentUsd / quota.limitUsd) * 100;
  const tone = quotaTone(percent);
  return (
    <article
      className={cardClassName({ tone, extra: 'bridge-quota' })}
      aria-label="Boise State quota"
    >
      <div className="card-head">
        <StatusDot tone={tone} />
        <span className="card-title">{`This month: ${formatUsd(quota.spentUsd)} of ${formatUsd(quota.limitUsd)}`}</span>
        {percent >= 100 ? <span className="chip">Used up</span> : null}
      </div>
      <Meter label="Boise State quota used" ratio={Math.min(1, percent / 100)} tone={tone} />
      <p className="card-text">{quotaSource(quota)}</p>
      <div className="card-foot">
        <a href={BOISESTATE_USAGE_URL}>Open boisestate.ai usage</a>
      </div>
    </article>
  );
}

/** Calls through the boisestate.ai bridge, which no Anthropic plan or price covers. */
export function BridgeSection(props: {
  readonly bridge: BridgeUsage | undefined;
}): ReactElement | null {
  const { bridge } = props;
  const now = useNow();
  if (bridge === undefined) {
    return null;
  }
  const today = bridgeTotals(bridge, localDate(now));
  const week = bridgeTotals(bridge, localDate(now - WEEK_MS + 24 * 60 * 60_000));
  const all = bridgeTotals(bridge);
  const days = bridge.days
    .toReversed()
    .slice(0, BRIDGE_DAYS)
    .map((day) => ({ ...day, key: day.date }));
  return (
    <section className="section bridge-usage" aria-labelledby="bridge-title">
      <h2 id="bridge-title" className="section-title">
        Boise State (boisestate.ai)
      </h2>
      <QuotaCard quota={bridge.quota} />
      <StatTiles label="Boise State usage">
        <StatTile label="Today" value={tokens(today)} detail={detail(today)} />
        <StatTile label="Last 7 days" value={tokens(week)} detail={detail(week)} />
        <StatTile label="All time" value={tokens(all)} detail={detail(all)} />
      </StatTiles>
      <details className="about">
        <summary>How this is counted</summary>
        <p>{COUNTED}</p>
      </details>
      <BridgeRows caption="Boise State usage by day" first="Date" rows={days} />
      {bridge.models.length > 1 ? (
        <BridgeRows
          caption="Boise State usage by model"
          first="Model"
          rows={bridge.models.map((model) => ({ ...model, key: model.model }))}
        />
      ) : null}
    </section>
  );
}
