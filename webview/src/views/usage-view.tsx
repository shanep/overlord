// Usage: plan limits, Boise State calls through the bridge, history totals,
// daily tokens by model, activity by hour, and a rough climate estimate.

import type { ReactElement } from 'react';
import { useMemo } from 'react';

import type { BridgeUsage, BridgeUsageTotals } from '../../../src/shared/bridge-usage.js';
import type {
  ClimateEstimate,
  PlanLimit,
  PlanLimits,
  UsageState,
} from '../../../src/shared/protocol.js';
import { knowsClaude, useAgents } from '../agents.js';
import { useChartTheme } from '../charts/chart-theme.js';
import {
  buildDailyUsage,
  buildHourHeatmap,
  dayTokens,
  hourValues,
  modelSeries,
  OTHER,
} from '../charts/usage-charts.js';
import { useNow } from '../clock.js';
import { Card, CardGrid, StatTile, StatTiles, StatusDot } from '../components/card.js';
import type { FigureTable } from '../components/chart-figure.js';
import { ChartFigure } from '../components/chart-figure.js';
import { Meter, meterTone } from '../components/meter.js';
import {
  formatAgo,
  formatCompact,
  formatDateTime,
  formatDuration,
  formatInteger,
} from '../format.js';
import type { Tone } from '../labels.js';

import type { NamedWindow } from './limit-windows.js';
import { otherWindows } from './limit-windows.js';

/** Table twin for the daily chart: one row per day, one column per series. */
export function dailyTable(state: UsageState): FigureTable {
  const days = state.days.toSorted((a, b) => a.date.localeCompare(b.date));
  const series = modelSeries(days);
  const named = series.filter((name) => name !== OTHER);
  return {
    columns: ['Date', ...series],
    rows: days.map((day) => [
      day.date,
      ...series.map((name) => formatInteger(dayTokens(day, name, named))),
    ]),
  };
}

/** Table twin for the heatmap, hours with no activity left out. */
export function hourTable(state: UsageState): FigureTable {
  const values = hourValues(state.hourCounts);
  return {
    columns: ['Hour', 'Count'],
    rows: values.flatMap((value, hour) =>
      value > 0 ? [[`${hour.toString().padStart(2, '0')}:00`, formatInteger(value)]] : [],
    ),
  };
}

export function totalTokensAll(state: UsageState): number {
  return state.days
    .flatMap((day) => Object.values(day.tokensByModel))
    .reduce((sum, tokens) => sum + tokens, 0);
}

function Stat(props: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="stat">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

/** The server grades each limit; the meter shows its grade, not its own. */
export function severityTone(severity: string): Tone {
  if (severity === 'critical' || severity === 'warning') {
    return severity;
  }
  return 'info';
}

function resetText(limit: PlanLimit, now: number): string {
  if (limit.resetsAt === null) {
    return '';
  }
  return `Resets in ${formatDuration(Math.max(0, limit.resetsAt - now))}`;
}

function PlanSection(props: { readonly plan: PlanLimits | null }): ReactElement | null {
  const { plan } = props;
  const now = useNow();
  if (plan === null || plan.limits.length === 0) {
    return null;
  }
  const subscription = plan.subscription === null ? '' : ` (${plan.subscription})`;
  return (
    <section className="plan-limits" aria-labelledby="plan-title">
      <div className="list-bar">
        <h2 id="plan-title">{`Plan limits${subscription}`}</h2>
        <span className="spacer" />
        <span className="muted">{`Updated ${formatAgo(plan.fetchedAt, now)}`}</span>
      </div>
      <CardGrid labelledBy="plan-title">
        {plan.limits.map((limit) => {
          const tone = severityTone(limit.severity);
          return (
            <Card key={`${limit.kind}:${limit.label}`} tone={tone}>
              <div className="card-head">
                <StatusDot tone={tone} />
                <span className="card-title">{limit.label}</span>
              </div>
              <Meter label={`${limit.label} used`} ratio={limit.percent / 100} tone={tone} />
              <span
                className="card-sub"
                title={limit.resetsAt === null ? undefined : formatDateTime(limit.resetsAt)}
              >
                {resetText(limit, now)}
              </span>
            </Card>
          );
        })}
      </CardGrid>
    </section>
  );
}

/** The usage limit windows other agents' sessions reported, one card each. */
function AgentLimitsSection(props: {
  readonly windows: readonly NamedWindow[];
}): ReactElement | null {
  const now = useNow();
  if (props.windows.length === 0) {
    return null;
  }
  return (
    <section className="plan-limits" aria-labelledby="agent-limits-title">
      <div className="list-bar">
        <h2 id="agent-limits-title">Agent limits</h2>
      </div>
      <CardGrid labelledBy="agent-limits-title">
        {props.windows.map(({ key, label, window }) => {
          const ratio = window.usedPct;
          const tone: Tone = ratio === null ? 'neutral' : meterTone(ratio);
          return (
            <Card key={key} tone={tone}>
              <div className="card-head">
                <StatusDot tone={tone} />
                <span className="card-title">{label}</span>
              </div>
              <Meter label={`${label} used`} ratio={ratio} />
              <span
                className="card-sub"
                title={window.resetsAt === null ? undefined : formatDateTime(window.resetsAt)}
              >
                {window.resetsAt === null
                  ? ''
                  : `Resets in ${formatDuration(Math.max(0, window.resetsAt - now))}`}
              </span>
            </Card>
          );
        })}
      </CardGrid>
    </section>
  );
}

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
  for (const day of bridge.days) {
    if (day.date >= from) {
      calls += day.calls;
      inputTokens += day.inputTokens;
      outputTokens += day.outputTokens;
    }
  }
  return { calls, inputTokens, outputTokens };
}

const tokens = (totals: BridgeUsageTotals): string =>
  formatCompact(totals.inputTokens + totals.outputTokens);

function BridgeRows(props: {
  readonly caption: string;
  readonly first: string;
  readonly rows: readonly (BridgeUsageTotals & { readonly key: string })[];
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
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr key={row.key}>
            <td>{row.key}</td>
            <td className="num">{formatInteger(row.calls)}</td>
            <td className="num">{formatCompact(row.inputTokens)}</td>
            <td className="num">{formatCompact(row.outputTokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Calls through the boisestate.ai bridge, which no Anthropic plan or price covers. */
function BridgeSection(props: { readonly bridge: BridgeUsage | undefined }): ReactElement | null {
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
      <StatTiles label="Boise State usage">
        <StatTile
          label="Today"
          value={tokens(today)}
          detail={`${formatInteger(today.calls)} calls`}
        />
        <StatTile
          label="Last 7 days"
          value={tokens(week)}
          detail={`${formatInteger(week.calls)} calls`}
        />
        <StatTile
          label="All time"
          value={tokens(all)}
          detail={`${formatInteger(all.calls)} calls`}
        />
      </StatTiles>
      <details className="about">
        <summary>How this is counted</summary>
        <p>
          boisestate.ai has no usage page, so the bridge logs every call it makes with the token
          counts the backend reports, from Claude Code sessions, the Launcher and anything else that
          uses it. Calls from before the log started, or made without the bridge, are not counted.
          None of it counts against a Claude plan.
        </p>
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

/** 0.04, 0.42, 9.8, 232, 1,480: more decimals for small amounts, none past 10. */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  let digits = 0;
  if (value < 1) {
    digits = 2;
  } else if (value < 10) {
    digits = 1;
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function ClimateSection(props: { readonly climate: ClimateEstimate }): ReactElement | null {
  const { climate } = props;
  if (climate.models.length === 0 && climate.unpricedTokens === 0) {
    return null;
  }
  const { assumptions } = climate;
  return (
    <section className="section climate" aria-labelledby="climate-title">
      <h2 id="climate-title" className="section-title">
        Climate impact (estimate)
      </h2>
      <StatTiles label="Climate impact">
        <StatTile label="Energy" value={`${formatAmount(climate.energyKwh)} kWh`} />
        <StatTile label="CO2e" value={`${formatAmount(climate.co2eKg)} kg`} />
        <StatTile label="Cooling water" value={`${formatAmount(climate.waterLiters)} L`} />
        <StatTile label="Same as driving" value={`${formatAmount(climate.drivingMiles)} miles`} />
        <StatTile label="Same as a US home for" value={`${formatAmount(climate.homeDays)} days`} />
      </StatTiles>
      <details className="about">
        <summary>How this is worked out</summary>
        <p>
          {`Anthropic does not publish energy per token, so this prices every token at list price and assumes ${formatAmount(assumptions.whPerListDollar)} Wh per dollar, ${formatAmount(assumptions.kgCo2ePerKwh)} kg CO2e per kWh and ${formatAmount(assumptions.litersPerKwh)} L of cooling water per kWh. It could be off by 3 times either way.`}
        </p>
        {climate.unpricedTokens > 0 ? (
          <p>
            {`${formatCompact(climate.unpricedTokens)} tokens from models with no list price are left out.`}
          </p>
        ) : null}
      </details>
      {climate.models.length > 0 ? (
        <table className="grid">
          <caption className="visually-hidden">Climate impact by model</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" className="num">
                Total tokens
              </th>
              <th scope="col" className="num">
                Energy (kWh)
              </th>
              <th scope="col" className="num">
                CO2e (kg)
              </th>
            </tr>
          </thead>
          <tbody>
            {climate.models.map((row) => (
              <tr key={row.model}>
                <td>{row.model}</td>
                <td className="num">{formatCompact(row.tokens)}</td>
                <td className="num">{formatAmount(row.energyKwh)}</td>
                <td className="num">{formatAmount(row.co2eKg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export function UsageView(props: { readonly state: UsageState }): ReactElement {
  const { state } = props;
  const theme = useChartTheme();
  // Plan limits are Claude Code's claude.ai plan, so they need Claude Code.
  const agents = useAgents();
  const claude = knowsClaude(agents);
  const daily = useMemo(() => buildDailyUsage(state.days, theme), [state.days, theme]);
  const heatmap = useMemo(
    () => buildHourHeatmap(state.hourCounts, theme),
    [state.hourCounts, theme],
  );
  const toolCalls = state.days.reduce((sum, day) => sum + day.toolCalls, 0);
  return (
    <section className="usage" aria-labelledby="usage-title">
      <header className="view-header">
        <h1 id="usage-title">Usage</h1>
        <dl className="stats">
          <Stat label="Sessions" value={formatInteger(state.totalSessions)} />
          <Stat label="Messages" value={formatInteger(state.totalMessages)} />
          <Stat label="Tokens" value={formatCompact(totalTokensAll(state))} />
          <Stat label="Tool calls" value={formatInteger(toolCalls)} />
          <Stat label="Days" value={state.days.length.toString()} />
        </dl>
      </header>
      <PlanSection plan={claude ? state.plan : null} />
      <AgentLimitsSection windows={otherWindows(state.windows, agents)} />
      <BridgeSection bridge={state.bridge} />
      <div className="charts chart-card">
        <ChartFigure
          title="Daily tokens by model"
          option={daily}
          height={220}
          table={dailyTable(state)}
        />
        <ChartFigure
          title="Activity by hour of day"
          option={heatmap}
          height={140}
          table={hourTable(state)}
        />
      </div>
      <ClimateSection climate={state.climate} />
    </section>
  );
}
