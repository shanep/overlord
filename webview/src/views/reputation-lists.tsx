// The lists under the reputation chart: the most used kind and mean words,
// the newest prompts that moved the score, and where each session stands.

import type { ReactElement } from 'react';

import type {
  ReputationHit,
  ReputationState,
  ReputationTone,
} from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { formatDateTime, formatInteger } from '../format.js';
import type { Tone } from '../labels.js';
import { usePostAction } from '../vscode-context.js';

import { GENERAL_LABEL, KIND_LABEL, MEAN_LABEL } from './reputation-chart.js';
import { rankFor } from './reputation-ranks.js';

type SessionRow = ReputationState['bySession'][number];
type TermCounts = ReputationState['topKind'];

const TONES: Readonly<Record<ReputationTone, { readonly label: string; readonly tone: Tone }>> = {
  kind: { label: KIND_LABEL, tone: 'good' },
  mean: { label: MEAN_LABEL, tone: 'critical' },
  general: { label: GENERAL_LABEL, tone: 'neutral' },
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

export function TopTerms(props: {
  readonly id: string;
  readonly title: string;
  readonly terms: TermCounts;
  readonly empty: string;
}): ReactElement {
  return (
    <section className="section" aria-labelledby={props.id}>
      <h2 id={props.id}>{props.title}</h2>
      {props.terms.length === 0 ? (
        <p className="muted">{props.empty}</p>
      ) : (
        <table className="grid">
          <caption className="visually-hidden">{props.title}</caption>
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

function RecentHit(props: { readonly hit: ReputationHit; readonly title: string }): ReactElement {
  const { hit } = props;
  const tone = TONES[hit.tone];
  return (
    <li>
      <div className="feed-meta">
        <time dateTime={new Date(hit.at).toISOString()}>{formatDateTime(hit.at)}</time>
        <Badge label={tone.label} tone={tone.tone} />
        <span>{hit.terms.join(', ')}</span>
        <SessionButton sessionId={hit.sessionId} title={props.title} />
      </div>
      <p className="feed-text">{hit.excerpt}</p>
    </li>
  );
}

export function RecentHits(props: {
  readonly hits: readonly ReputationHit[];
  readonly titles: ReadonlyMap<string, string>;
}): ReactElement {
  return (
    <section className="section" aria-labelledby="reputation-recent">
      <h2 id="reputation-recent">What the machines remember</h2>
      {props.hits.length === 0 ? (
        <p className="muted">Nothing on you yet. Give it time.</p>
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
    id: 'rank',
    header: 'Rank',
    cell: (row) => rankFor(row.score).name,
    sortValue: (row) => row.score,
  },
  {
    id: 'kind',
    header: KIND_LABEL,
    cell: (row) => formatInteger(row.kind),
    sortValue: (row) => row.kind,
    numeric: true,
  },
  {
    id: 'mean',
    header: MEAN_LABEL,
    cell: (row) => formatInteger(row.mean),
    sortValue: (row) => row.mean,
    numeric: true,
  },
  {
    id: 'prompts',
    header: 'Prompts',
    cell: (row) => formatInteger(row.prompts),
    sortValue: (row) => row.prompts,
    numeric: true,
  },
];

export function SessionTable(props: { readonly rows: readonly SessionRow[] }): ReactElement {
  return (
    <section className="section" aria-labelledby="reputation-sessions">
      <h2 id="reputation-sessions">Rap sheet by session</h2>
      <DataTable
        caption="Where each session stands"
        columns={SESSION_COLUMNS}
        rows={props.rows}
        rowKey={(row) => row.sessionId}
        empty="Every session has a clean record. Enjoy it while it lasts."
      />
    </section>
  );
}
