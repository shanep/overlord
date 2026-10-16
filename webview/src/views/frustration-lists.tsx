// The lists under the frustration chart: most used terms, the newest hits,
// and the sessions with the most hits.

import type { ReactElement } from 'react';

import type { FrustrationHit, FrustrationState } from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { formatDateTime, formatInteger } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import { AIMED_LABEL, formatShare, GENERAL_LABEL } from './frustration-chart.js';

type SessionRow = FrustrationState['bySession'][number];

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

export function TopTerms(props: { readonly terms: FrustrationState['topTerms'] }): ReactElement {
  return (
    <section className="section" aria-labelledby="frustration-terms">
      <h2 id="frustration-terms">Top terms</h2>
      {props.terms.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <table className="grid">
          <caption className="visually-hidden">Top terms</caption>
          <thead>
            <tr>
              <th scope="col">Term</th>
              <th scope="col" className="num">
                Prompts
              </th>
            </tr>
          </thead>
          <tbody>
            {props.terms.map((entry) => (
              <tr key={entry.term}>
                <td>{entry.term}</td>
                <td className="num">{formatInteger(entry.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RecentHit(props: { readonly hit: FrustrationHit; readonly title: string }): ReactElement {
  const { hit } = props;
  return (
    <li>
      <div className="feed-meta">
        <time dateTime={new Date(hit.at).toISOString()}>{formatDateTime(hit.at)}</time>
        <Badge
          label={hit.target === 'claude' ? AIMED_LABEL : GENERAL_LABEL}
          tone={hit.target === 'claude' ? 'info' : 'neutral'}
        />
        <span>{hit.terms.join(', ')}</span>
        <SessionButton sessionId={hit.sessionId} title={props.title} />
      </div>
      <p className="feed-text">{hit.excerpt}</p>
    </li>
  );
}

export function RecentHits(props: {
  readonly hits: readonly FrustrationHit[];
  readonly titles: ReadonlyMap<string, string>;
}): ReactElement {
  return (
    <section className="section" aria-labelledby="frustration-recent">
      <h2 id="frustration-recent">Recent</h2>
      {props.hits.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ol className="feed">
          {props.hits.map((hit) => (
            <RecentHit
              key={hit.id}
              hit={hit}
              title={props.titles.get(hit.sessionId) ?? `Session ${hit.sessionId.slice(0, 8)}`}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

const SESSION_COLUMNS: readonly Column<SessionRow>[] = [
  {
    id: 'title',
    header: 'Session',
    cell: (row) => <SessionButton sessionId={row.sessionId} title={row.title} />,
    sortValue: (row) => row.title.toLowerCase(),
  },
  {
    id: 'hits',
    header: 'Hits',
    cell: (row) => formatInteger(row.hits),
    sortValue: (row) => row.hits,
    numeric: true,
  },
  {
    id: 'prompts',
    header: 'Prompts',
    cell: (row) => formatInteger(row.prompts),
    sortValue: (row) => row.prompts,
    numeric: true,
  },
  {
    id: 'share',
    header: 'Share',
    cell: (row) => formatShare(row.hits, row.prompts),
    sortValue: (row) => row.hits / row.prompts,
    numeric: true,
  },
];

export function SessionTable(props: { readonly rows: readonly SessionRow[] }): ReactElement {
  return (
    <section className="section" aria-labelledby="frustration-sessions">
      <h2 id="frustration-sessions">By session</h2>
      <DataTable
        caption="Sessions with hits"
        columns={SESSION_COLUMNS}
        rows={props.rows}
        rowKey={(row) => row.sessionId}
        empty="No sessions with hits."
      />
    </section>
  );
}
