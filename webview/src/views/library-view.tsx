// The Skills and Agents views: make a new one, see the ones installed in
// every scope, and install premade ones from public collections.

import type { ReactElement } from 'react';

import type { CatalogKind, LibraryItem, LibraryState } from '../../../src/shared/catalog.js';
import type { ConfigScope } from '../../../src/shared/model.js';
import { Badge } from '../components/badge.js';
import { Avatar, Card, CardGroup } from '../components/card.js';
import { usePostAction } from '../vscode-context.js';

import { STATUS_INFO } from './config-labels.js';
import { CatalogSection } from './library-catalog.js';

interface KindText {
  readonly title: string;
  readonly one: string;
  readonly about: string;
  readonly empty: string;
}

const TEXT: Readonly<Record<CatalogKind, KindText>> = {
  skill: {
    title: 'Skills',
    one: 'skill',
    about:
      "A skill teaches Claude one kind of task. Every session sees each skill's name and description, and Claude reads the rest only when a task calls for it, so a skill costs little until it is used. User skills reach every project and project skills only that project.",
    empty: 'No skills yet. Make one or install one below.',
  },
  agent: {
    title: 'Agents',
    one: 'agent',
    about:
      'An agent is a helper with its own prompt, tools and model. A session hands it a task and gets back only the answer, which keeps the main conversation small. User agents reach every project and project agents only that project.',
    empty: 'No agents yet. Make one or install one below.',
  },
};

interface ScopeGroup {
  readonly id: string;
  readonly title: string;
  readonly scopes: readonly ConfigScope[];
}

const SCOPE_GROUPS: readonly ScopeGroup[] = [
  { id: 'library-user', title: 'For every project', scopes: ['user'] },
  { id: 'library-project', title: 'This project', scopes: ['project', 'local'] },
  { id: 'library-plugin', title: 'From plugins', scopes: ['plugin'] },
  { id: 'library-managed', title: 'Set by your organization', scopes: ['managed', 'cloud'] },
];

function Installed(props: { readonly item: LibraryItem }): ReactElement {
  const post = usePostAction();
  const { item } = props;
  const { path, realPath } = item;
  const info = STATUS_INFO[item.status];
  return (
    <Card action>
      <div className="card-head">
        <Avatar seed={item.name} text={item.name} />
        <div className="card-titles">
          <span className="card-title" title={item.name}>
            {item.name}
          </span>
          <span className="card-sub mono" title={path ?? undefined}>
            {path ?? 'no file'}
          </span>
        </div>
      </div>
      {realPath === null ? null : (
        <p className="card-text" title={realPath}>
          Links to {realPath}
        </p>
      )}
      <div className="card-foot">
        <Badge label={info.label} tone={info.tone} title={info.meaning} />
        {(item.agents ?? []).map((agent) => (
          <span key={agent} className="chip" title={`${agent} reads it`}>
            {agent}
          </span>
        ))}
        <span className="spacer" />
        {path === null ? null : (
          <button
            type="button"
            aria-label={`Open ${item.name}`}
            onClick={() => {
              post({ type: 'openFile', path });
            }}
          >
            Open
          </button>
        )}
      </div>
    </Card>
  );
}

export function LibraryView(props: { readonly state: LibraryState }): ReactElement {
  const { kind, installed, catalog } = props.state;
  const text = TEXT[kind];
  const post = usePostAction();
  const sorted = installed.toSorted((left, right) => left.name.localeCompare(right.name));
  const names = new Set(installed.map((item) => item.name));
  const user = installed.filter((item) => item.scope === 'user').length;
  return (
    <section className="library" aria-labelledby="library-title">
      <header className="view-header">
        <h1 id="library-title">{text.title}</h1>
        <dl className="stats">
          <div className="stat">
            <dt>Installed</dt>
            <dd>{String(installed.length)}</dd>
          </div>
          <div className="stat">
            <dt>For every project</dt>
            <dd>{String(user)}</dd>
          </div>
        </dl>
        <span className="spacer" />
        <button
          type="button"
          className="primary"
          title="Start from a template, or describe it and let Claude draft it."
          onClick={() => {
            post({ type: kind === 'skill' ? 'newSkill' : 'newAgent' });
          }}
        >
          New {text.one}
        </button>
      </header>
      <details className="about">
        <summary>How this works</summary>
        <p>{text.about}</p>
        <p>
          New {text.one} starts from a template, or you describe it and Claude drafts it. Install on
          a premade one asks where it goes the same way, copies it from GitHub, and opens it so you
          can read it.
        </p>
      </details>
      {installed.length === 0 ? <p className="empty-line muted">{text.empty}</p> : null}
      {SCOPE_GROUPS.map((group) => {
        const items = sorted.filter((item) => group.scopes.includes(item.scope));
        return (
          <CardGroup key={group.id} id={group.id} title={group.title} count={items.length}>
            {items.map((item) => (
              <Installed key={item.id} item={item} />
            ))}
          </CardGroup>
        );
      })}
      <CatalogSection kind={kind} catalog={catalog} installedNames={names} />
    </section>
  );
}
