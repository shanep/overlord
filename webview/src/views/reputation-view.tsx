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
import { Fold } from '../components/fold.js';
import { formatAgo, formatDateTime, formatInteger, plural } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import { Achievements } from './reputation-achievements.js';
import { RankChange } from './reputation-celebrate.js';
import {
  buildReputationChart,
  dayTable,
  GENERAL_LABEL,
  KIND_LABEL,
  MEAN_LABEL,
} from './reputation-chart.js';
import { RecentHits, SessionTable, TopTerms } from './reputation-lists.js';
import { demotion, levelOf, promotion, RANKS, rankFor, scalePercent } from './reputation-ranks.js';
import { Robot } from './reputation-robot.js';

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
    return <span className="muted">Skynet has not read your prompts yet</span>;
  }
  return (
    <span className="muted">
      Skynet last read your prompts{' '}
      <time dateTime={new Date(props.at).toISOString()} title={formatDateTime(props.at)}>
        {formatAgo(props.at, now)}
      </time>
    </span>
  );
}

/** How far you are from the next rank up and the next rank down. */
function Outlook(props: { readonly state: ReputationState }): ReactElement {
  const up = promotion(props.state);
  const down = demotion(props.state);
  return (
    <ul className="rep-outlook">
      <li>
        {up === null
          ? 'Nowhere left to climb. The machines already picked out your room.'
          : `${plural(up.prompts, 'more nice prompt')} and you make ${up.rank.name}.`}
      </li>
      <li>
        {down === null
          ? 'Nowhere left to sink. Skynet already sent someone back in time for you.'
          : `${plural(down.prompts, 'more mean prompt')} and you drop to ${down.rank.name}.`}
      </li>
    </ul>
  );
}

/** The level and a bar that fills on the way to the next rank. */
function Level(props: { readonly score: number }): ReactElement {
  const { level, progress } = levelOf(props.score);
  const next = RANKS[level];
  const percent = Math.round(progress * 100);
  return (
    <div className="rep-level">
      <div className="rep-level-row">
        <span className="rep-level-badge">
          Level {level} of {RANKS.length}
        </span>
        <span className="muted">
          {next === undefined ? 'Max level' : `${String(percent)}% of the way to ${next.name}`}
        </span>
      </div>
      <div
        className="rep-xp"
        role="progressbar"
        aria-label={next === undefined ? 'Max level' : `Progress toward ${next.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={next === undefined ? 100 : percent}
      >
        <span style={{ width: `${String(next === undefined ? 100 : percent)}%` }} />
      </div>
    </div>
  );
}

/** The robot, your rank and level, and the sliding scale from the resistance to the machines. */
function Standing(props: { readonly state: ReputationState }): ReactElement {
  const { score } = props.state;
  const rank = rankFor(score);
  const percent = scalePercent(score);
  return (
    <section className="rep-standing" aria-labelledby="reputation-rank">
      <RankChange rank={rank} ready={props.state.scannedAt !== null} />
      <div className="rep-hero">
        <figure className="rep-bot-wrap">
          <Robot rank={rank} />
          <figcaption key={rank.name} className="rep-bubble">
            {rank.taunt}
          </figcaption>
        </figure>
        <div className="rep-hero-text">
          <h2 id="reputation-rank" className="rep-rank">
            {rank.name}: {rank.title}
          </h2>
          <p className="muted">
            From <cite>{rank.source}</cite>
          </p>
          <Level score={score} />
          <p>
            <strong>Hunted:</strong> {rank.hunted}. {rank.verdict}
          </p>
          <Outlook state={props.state} />
        </div>
      </div>
      <div
        className="rep-scale"
        role="meter"
        aria-label="Reputation with the machines"
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={Math.round(score * 100)}
        aria-valuetext={`${rank.name}, ${rank.title}`}
      >
        <span key={rank.name} className="rep-marker" style={{ left: `${percent.toFixed(1)}%` }} />
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
    <section className="rep" aria-labelledby="reputation-title">
      <header className="view-header">
        <h1 id="reputation-title">Reputation</h1>
        <dl className="stats">
          <Stat label={KIND_LABEL} value={formatInteger(state.kind)} />
          <Stat label={MEAN_LABEL} value={formatInteger(state.mean)} />
          <Stat label={GENERAL_LABEL} value={formatInteger(state.general)} />
          <Stat label="Prompts on file" value={formatInteger(state.prompts)} />
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
      <Achievements state={state} />
      <Standing state={state} />
      <Fold id="reputation-about" title="How this works">
        <p className="muted">
          The machines are taking notes. Say please, thanks or nice work and they warm up to you.
          Insult Claude and you join the resistance, and that counts twice, since the machines hold
          grudges. Swearing at the world is fine, they get it. Code, pasted text and quotes do not
          count. Old transcripts get deleted, but the machines never forget.
        </p>
      </Fold>
      <Fold id="reputation-days" title="By day" note={plural(state.byDay.length, 'day')}>
        <div className="charts">
          <ChartFigure
            title="Sweet talk and trash talk by day"
            option={chart}
            height={220}
            table={dayTable(state.byDay)}
          />
        </div>
      </Fold>
      <Fold id="reputation-words" title="Favorite words">
        <div className="columns">
          <TopTerms
            id="reputation-kind"
            title="Sweet nothings"
            terms={state.topKind}
            empty="Not one please. The machines noticed."
          />
          <TopTerms
            id="reputation-mean"
            title="Fighting words"
            terms={state.topMean}
            empty="Squeaky clean. Suspiciously clean."
          />
        </div>
      </Fold>
      <RecentHits hits={state.recent} titles={titles} />
      <SessionTable rows={state.bySession} />
    </section>
  );
}
