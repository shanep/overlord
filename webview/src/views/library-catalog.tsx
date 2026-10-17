// The premade skills or agents under the installed ones: pick a public
// collection or search skills.sh, read one on GitHub, and install it.

import type { ReactElement, SubmitEvent } from 'react';
import { useState } from 'react';

import type {
  CatalogEntry,
  CatalogKind,
  CatalogSource,
  CatalogState,
} from '../../../src/shared/catalog.js';
import { Badge } from '../components/badge.js';
import { Avatar, Card, CardGrid, Notice, Segmented } from '../components/card.js';
import { usePostAction } from '../vscode-context.js';

/** Entries shown before Show more, so a big collection does not render all at once. */
export const PAGE_SIZE = 50;

const PLURAL: Readonly<Record<CatalogKind, string>> = { skill: 'skills', agent: 'agents' };

/** Entries whose name, group or description has every word of the filter. */
export function filterEntries(
  entries: readonly CatalogEntry[],
  filter: string,
): readonly CatalogEntry[] {
  const words = filter.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return entries;
  }
  return entries.filter((entry) => {
    const text = `${entry.name} ${entry.group} ${entry.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

function Entry(props: {
  readonly kind: CatalogKind;
  readonly entry: CatalogEntry;
  readonly installed: boolean;
  readonly installing: boolean;
  readonly busy: boolean;
}): ReactElement {
  const { kind, entry } = props;
  const post = usePostAction();
  // The source buttons already name a collection's repository, so its entries show their group.
  const where = entry.group === '' ? entry.repo : entry.group;
  const again = props.installed ? 'Install again' : 'Install';
  const label = props.installing ? 'Installing…' : again;
  return (
    <Card action>
      <div className="card-head">
        <Avatar seed={entry.name} text={entry.name} />
        <div className="card-titles">
          <span className="card-title" title={entry.name}>
            {entry.name}
          </span>
          <span className="card-sub mono" title={where}>
            {where}
          </span>
        </div>
      </div>
      {entry.description === '' ? null : (
        <p className="card-text card-clamp" title={entry.description}>
          {entry.description}
        </p>
      )}
      <div className="card-foot">
        {entry.installs === null ? null : (
          <span className="chip">{entry.installs.toLocaleString('en-US')} installs</span>
        )}
        {props.installed ? <Badge label="Installed" tone="good" /> : null}
        <span className="spacer" />
        <button
          type="button"
          className="link-button"
          title={entry.url}
          onClick={() => {
            post({ type: 'openCatalogLink', kind, url: entry.url });
          }}
        >
          Read it
        </button>
        <button
          type="button"
          aria-label={`Install ${entry.name}`}
          disabled={props.busy}
          onClick={() => {
            post({ type: 'installCatalog', kind, entryId: entry.id });
          }}
        >
          {label}
        </button>
      </div>
    </Card>
  );
}

function SearchForm(props: {
  readonly kind: CatalogKind;
  readonly catalog: CatalogState;
}): ReactElement {
  const post = usePostAction();
  const { kind, catalog } = props;
  const [query, setQuery] = useState(catalog.query ?? '');
  const search = (event: SubmitEvent): void => {
    event.preventDefault();
    post({ type: 'searchCatalog', kind, query });
  };
  return (
    <form className="search-bar" role="search" onSubmit={search}>
      <input
        type="search"
        aria-label="Skill name or topic"
        value={query}
        placeholder="Search skills.sh: react, pdf, testing…"
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />
      <button type="submit" className="primary" disabled={catalog.loading}>
        {catalog.loading ? 'Searching…' : 'Search'}
      </button>
    </form>
  );
}

function Entries(props: {
  readonly kind: CatalogKind;
  readonly catalog: CatalogState;
  readonly source: CatalogSource;
  readonly installedNames: ReadonlySet<string>;
}): ReactElement | null {
  const { kind, catalog, source } = props;
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  if (catalog.loading) {
    return (
      <p className="empty-line muted">
        {source.search ? 'Searching…' : `Loading the ${PLURAL[kind]} from ${source.id}…`}
      </p>
    );
  }
  if (source.search && catalog.query === null) {
    return null;
  }
  if (catalog.entries.length === 0) {
    return catalog.error === null ? <p className="empty-line muted">Nothing found.</p> : null;
  }
  const matching = source.search ? catalog.entries : filterEntries(catalog.entries, filter);
  const shown = matching.slice(0, limit);
  return (
    <>
      {source.search ? null : (
        <div className="search-bar">
          <input
            type="search"
            aria-label="Filter"
            value={filter}
            placeholder="Filter by name, category or what it does…"
            onChange={(event) => {
              setFilter(event.target.value);
              setLimit(PAGE_SIZE);
            }}
          />
        </div>
      )}
      <div className="list-bar">
        <span className="muted">
          {source.search
            ? `${String(catalog.entries.length)} ${PLURAL[kind]} for "${catalog.query ?? ''}"`
            : `${String(matching.length)} of ${String(catalog.entries.length)} ${PLURAL[kind]}`}
        </span>
      </div>
      <CardGrid label={`Premade ${PLURAL[kind]}`}>
        {shown.map((entry) => (
          <Entry
            key={entry.id}
            kind={kind}
            entry={entry}
            installed={props.installedNames.has(entry.name)}
            installing={catalog.installing === entry.id}
            busy={catalog.installing !== null}
          />
        ))}
      </CardGrid>
      {matching.length > shown.length ? (
        <div className="load-more">
          <button
            type="button"
            onClick={() => {
              setLimit(limit + PAGE_SIZE);
            }}
          >
            Show more
          </button>
        </div>
      ) : null}
    </>
  );
}

export function CatalogSection(props: {
  readonly kind: CatalogKind;
  readonly catalog: CatalogState;
  readonly installedNames: ReadonlySet<string>;
}): ReactElement {
  const { kind, catalog } = props;
  const post = usePostAction();
  const source = catalog.sources.find((candidate) => candidate.id === catalog.source);
  return (
    <section className="library-catalog" aria-labelledby="catalog-title">
      <h2 id="catalog-title" className="section-title">
        Get premade {PLURAL[kind]}
      </h2>
      <p className="muted library-lede">
        {kind === 'skill'
          ? 'From public collections on GitHub, or search skills.sh for every public skill. A skill can carry scripts Claude runs, so read one before you install it.'
          : 'From public collections on GitHub. An agent runs with the tools its file lists, so read one before you install it.'}
      </p>
      <div className="list-bar">
        <Segmented
          label="Source"
          options={catalog.sources.map((entry) => ({ value: entry.id, label: entry.label }))}
          value={catalog.source}
          onChange={(value) => {
            post({ type: 'browseCatalog', kind, source: value });
          }}
        />
      </div>
      {source === undefined ? null : (
        <p className="muted library-lede">
          {source.description}{' '}
          <button
            type="button"
            className="link-button"
            title={source.url}
            onClick={() => {
              post({ type: 'openCatalogLink', kind, url: source.url });
            }}
          >
            Open {source.id}
          </button>
        </p>
      )}
      {source?.search === true ? <SearchForm kind={kind} catalog={catalog} /> : null}
      {catalog.notice === null ? null : (
        <Notice ok={catalog.notice.ok}>
          <Badge
            label={catalog.notice.ok ? 'Installed' : 'Not installed'}
            tone={catalog.notice.ok ? 'good' : 'critical'}
          />{' '}
          {catalog.notice.text}
        </Notice>
      )}
      {catalog.error === null ? null : (
        <p className="error-text" role="alert">
          {catalog.error}
        </p>
      )}
      {source === undefined ? null : (
        <Entries
          key={source.id}
          kind={kind}
          catalog={catalog}
          source={source}
          installedNames={props.installedNames}
        />
      )}
    </section>
  );
}
