// The parts of the Tuning view: the advice cards, the skills and agents to
// add, and the per-session table.

import type { ReactElement } from 'react';

import type { Suggestion, Tip, TipSeverity, TuningSessionRow } from '../../../src/shared/tuning.js';
import { Badge } from '../components/badge.js';
import { Avatar, cardClassName, Notice, StatusDot } from '../components/card.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import {
  formatCompact,
  formatCost,
  formatDateTime,
  formatInteger,
  formatPercent,
} from '../format.js';
import type { Tone } from '../labels.js';
import { usePostAction } from '../vscode-context.js';

import { TipResults, VERDICT_INFO } from './tuning-impact.js';

export const SEVERITY_INFO: Readonly<Record<TipSeverity, { label: string; tone: Tone }>> = {
  high: { label: 'High impact', tone: 'critical' },
  medium: { label: 'Medium impact', tone: 'warning' },
  low: { label: 'Low impact', tone: 'info' },
};

function SessionButton(props: {
  readonly sessionId: string;
  readonly title: string;
}): ReactElement {
  const post = usePostAction();
  return (
    <button
      type="button"
      className="link-button"
      title="Open the agent view for this session"
      onClick={() => {
        post({ type: 'openAgent', sessionId: props.sessionId, agentId: props.sessionId });
      }}
    >
      {props.title}
    </button>
  );
}

/** What following a recommendation gains and what it gives up, side by side. */
function Tradeoffs(props: {
  readonly id: string;
  readonly pros: readonly string[];
  readonly cons: readonly string[];
}): ReactElement {
  return (
    <div className="tradeoffs">
      <div>
        <h4 id={`${props.id}-pros`}>Pros</h4>
        <ul aria-labelledby={`${props.id}-pros`}>
          {props.pros.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div>
        <h4 id={`${props.id}-cons`}>Cons</h4>
        <ul aria-labelledby={`${props.id}-cons`}>
          {props.cons.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TipCard(props: {
  readonly tip: Tip;
  readonly names: ReadonlyMap<string, string>;
}): ReactElement {
  const { tip } = props;
  const severity = SEVERITY_INFO[tip.severity];
  const headingId = `tip-${tip.id}`;
  const fixes = tip.fixes.flatMap((id) => {
    const name = props.names.get(id);
    return name === undefined ? [] : [name];
  });
  return (
    <article
      className={cardClassName({ tone: severity.tone, extra: 'tip' })}
      aria-labelledby={headingId}
    >
      <header className="tip-header">
        <StatusDot tone={severity.tone} />
        <h3 id={headingId}>{tip.title}</h3>
        <Badge label={severity.label} tone={severity.tone} />
        {tip.impact === null ? null : (
          <Badge
            label={VERDICT_INFO[tip.impact.verdict].label}
            tone={VERDICT_INFO[tip.impact.verdict].tone}
          />
        )}
      </header>
      <p>{tip.finding}</p>
      <TipResults tipId={tip.id} impact={tip.impact} />
      <details>
        <summary>What to do</summary>
        <ul className="tip-advice">
          {tip.advice.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <Tradeoffs id={headingId} pros={tip.pros} cons={tip.cons} />
        <p>
          <strong>Skip it when:</strong> {tip.skipWhen}
        </p>
        {fixes.length === 0 ? null : (
          <p className="muted">
            Would help:{' '}
            {fixes.map((name, index) => (
              <span key={name}>
                {index === 0 ? '' : ', '}
                <code>{name}</code>
              </span>
            ))}
          </p>
        )}
      </details>
      {tip.sessions.length === 0 ? null : (
        <details>
          <summary>Worst sessions</summary>
          <ul className="props-list">
            {tip.sessions.map((session) => (
              <li key={session.sessionId}>
                <SessionButton sessionId={session.sessionId} title={session.title} />{' '}
                <span className="muted">{session.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

export function TipList(props: {
  readonly tips: readonly Tip[];
  readonly names: ReadonlyMap<string, string>;
}): ReactElement {
  return (
    <section className="card-group" aria-labelledby="tips-advice">
      <h2 id="tips-advice">
        Advice{' '}
        {props.tips.length === 0 ? null : (
          <span className="count">{String(props.tips.length)}</span>
        )}
      </h2>
      {props.tips.length === 0 ? (
        <Notice ok>Nothing stands out. Your sessions look lean.</Notice>
      ) : (
        <div className="card-grid card-grid-wide tips">
          {props.tips.map((tip) => (
            <TipCard key={tip.id} tip={tip} names={props.names} />
          ))}
        </div>
      )}
    </section>
  );
}

function SuggestionCard(props: { readonly suggestion: Suggestion }): ReactElement {
  const { suggestion } = props;
  const post = usePostAction();
  const headingId = `suggestion-${suggestion.id}`;
  return (
    <article className={cardClassName({ extra: 'tip' })} aria-labelledby={headingId}>
      <header className="tip-header">
        <Avatar seed={suggestion.name} text={suggestion.name} />
        <h3 id={headingId}>
          <code>{suggestion.name}</code>
        </h3>
        <Badge label={suggestion.kind === 'skill' ? 'Skill' : 'Agent'} tone="info" />
        {suggestion.installed ? <Badge label="Installed" tone="good" /> : null}
      </header>
      <p>{suggestion.summary}</p>
      <p className="muted">{suggestion.reason ?? 'Nothing in your sessions calls for it yet.'}</p>
      <details>
        <summary>Pros and cons</summary>
        <Tradeoffs id={headingId} pros={suggestion.pros} cons={suggestion.cons} />
      </details>
      <div className="card-foot">
        <span className="spacer" />
        <button
          type="button"
          className={suggestion.installed ? undefined : 'primary'}
          title={`Write the ${suggestion.kind} file, then open it to review`}
          onClick={() => {
            post({ type: 'createSuggestion', suggestionId: suggestion.id });
          }}
        >
          {suggestion.installed ? 'Create again' : 'Create'}
        </button>
      </div>
    </article>
  );
}

export function SuggestionList(props: {
  readonly suggestions: readonly Suggestion[];
}): ReactElement {
  return (
    <section className="card-group" aria-labelledby="tuning-suggestions">
      <h2 id="tuning-suggestions">Skills and agents to add</h2>
      <p className="muted">
        Each one takes over work your sessions keep doing by hand. Create asks where to save it and
        opens the file so you can review it.
      </p>
      <div className="card-grid card-grid-wide tips">
        {props.suggestions.map((suggestion) => (
          <SuggestionCard key={suggestion.id} suggestion={suggestion} />
        ))}
      </div>
    </section>
  );
}

function sessionColumns(titles: ReadonlyMap<string, string>): readonly Column<TuningSessionRow>[] {
  return [
    {
      id: 'title',
      header: 'Session',
      cell: (row) => <SessionButton sessionId={row.sessionId} title={row.title} />,
      sortValue: (row) => row.title.toLowerCase(),
    },
    {
      id: 'updated',
      header: 'Last active',
      cell: (row) => formatDateTime(row.updatedAt),
      sortValue: (row) => row.updatedAt,
    },
    {
      id: 'prompts',
      header: 'Prompts',
      cell: (row) => formatInteger(row.prompts),
      sortValue: (row) => row.prompts,
      numeric: true,
    },
    {
      id: 'peak',
      header: 'Peak context',
      cell: (row) => formatCompact(row.peakContext),
      sortValue: (row) => row.peakContext,
      numeric: true,
    },
    {
      id: 'average',
      header: 'Average context',
      cell: (row) => formatCompact(row.averageContext),
      sortValue: (row) => row.averageContext,
      numeric: true,
    },
    {
      id: 'cost',
      header: 'Cost',
      cell: (row) => formatCost(row.costUsd),
      sortValue: (row) => row.costUsd,
      numeric: true,
    },
    {
      id: 'reread',
      header: 'Re-reading',
      cell: (row) => formatPercent(row.cacheReadShare),
      sortValue: (row) => row.cacheReadShare,
      numeric: true,
    },
    {
      id: 'tips',
      header: 'Tips',
      cell: (row) => (
        <span title={row.tips.map((id) => titles.get(id) ?? id).join('\n')}>
          {formatInteger(row.tips.length)}
        </span>
      ),
      sortValue: (row) => row.tips.length,
      numeric: true,
    },
  ];
}

export function TuningSessionTable(props: {
  readonly rows: readonly TuningSessionRow[];
  readonly titles: ReadonlyMap<string, string>;
}): ReactElement {
  return (
    <section className="section" aria-labelledby="tuning-sessions">
      <details>
        <summary>
          <h2 id="tuning-sessions">Sessions by cost</h2>{' '}
          <span className="muted">{formatInteger(props.rows.length)}</span>
        </summary>
        <DataTable
          caption="Sessions by cost"
          columns={sessionColumns(props.titles)}
          rows={props.rows}
          rowKey={(row) => row.sessionId}
          empty="No sessions measured yet."
        />
      </details>
    </section>
  );
}
