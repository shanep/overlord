// Premade skills and agents from the Skills and Agents catalogs that fit the
// kinds of work the sessions show, each with what pointed at it, a link to
// read it and an Install button that works like the one in those views.

import type { ReactElement } from 'react';

import type { CatalogPick, CatalogPicks } from '../../../src/shared/tuning.js';
import { Badge } from '../components/badge.js';
import { Avatar, Card, CardGrid, Notice } from '../components/card.js';
import { usePostAction } from '../vscode-context.js';

function PickCard(props: {
  readonly pick: CatalogPick;
  readonly installing: boolean;
  readonly busy: boolean;
}): ReactElement {
  const { pick } = props;
  const post = usePostAction();
  return (
    <Card action>
      <div className="card-head">
        <Avatar seed={pick.name} text={pick.name} />
        <div className="card-titles">
          <span className="card-title" title={pick.name}>
            {pick.name}
          </span>
          <span className="card-sub mono" title={pick.repo}>
            {pick.repo}
          </span>
        </div>
        <Badge label={pick.kind === 'skill' ? 'Skill' : 'Agent'} tone="info" />
      </div>
      {pick.description === '' ? null : (
        <p className="card-text card-clamp" title={pick.description}>
          {pick.description}
        </p>
      )}
      <p className="card-text">{`For your ${pick.topic} work: ${pick.reason}`}</p>
      <div className="card-foot">
        {pick.installs === null ? null : (
          <span className="chip">{`${pick.installs.toLocaleString('en-US')} installs`}</span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="link-button"
          title={pick.url}
          onClick={() => {
            post({ type: 'openPickLink', pickId: pick.id });
          }}
        >
          Read it
        </button>
        <button
          type="button"
          aria-label={`Install ${pick.name}`}
          disabled={props.busy}
          onClick={() => {
            post({ type: 'installPick', pickId: pick.id });
          }}
        >
          {props.installing ? 'Installing…' : 'Install'}
        </button>
      </div>
    </Card>
  );
}

function Status(props: { readonly picks: CatalogPicks }): ReactElement | null {
  const { picks } = props;
  if (picks.loading) {
    return <p className="empty-line">{`Searching the catalogs for ${picks.topics.join(', ')}…`}</p>;
  }
  if (picks.topics.length === 0) {
    return (
      <p className="empty-line">
        No language or tool stands out in your sessions yet, so there is nothing to search for.
      </p>
    );
  }
  if (picks.picks.length === 0 && picks.error === null) {
    return (
      <p className="empty-line">{`Nothing new in the catalogs for ${picks.topics.join(', ')}.`}</p>
    );
  }
  return null;
}

export function PickList(props: { readonly picks: CatalogPicks }): ReactElement {
  const { picks } = props;
  return (
    <section className="card-group" aria-labelledby="tuning-picks">
      <h2 id="tuning-picks">
        From the Skills and Agents catalogs{' '}
        {picks.picks.length === 0 ? null : (
          <span className="count">{String(picks.picks.length)}</span>
        )}
      </h2>
      <p className="muted">
        Premade skills and agents that fit the languages and tools your sessions use most. They come
        from other people, so read one before you install it.
      </p>
      <Status picks={picks} />
      {picks.error === null ? null : <p className="empty-line">{picks.error}</p>}
      {picks.notice === null ? null : <Notice ok={picks.notice.ok}>{picks.notice.text}</Notice>}
      {picks.picks.length === 0 ? null : (
        <CardGrid labelledBy="tuning-picks">
          {picks.picks.map((pick) => (
            <PickCard
              key={pick.id}
              pick={pick}
              installing={picks.installing === pick.id}
              busy={picks.installing !== null}
            />
          ))}
        </CardGrid>
      )}
    </section>
  );
}
