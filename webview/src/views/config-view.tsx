// Every config item on the machine, grouped by kind, with its sync status
// and the config repo's state.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { ConfigItem, ConfigKind, ConfigStatus } from '../../../src/shared/model.js';
import type { ConfigState, ConfigSyncStatus } from '../../../src/shared/protocol.js';
import { useNow } from '../clock.js';
import { Badge } from '../components/badge.js';
import { Card, CardGroup, StatusDot } from '../components/card.js';
import { EmptyState } from '../components/empty-state.js';
import { formatAgo } from '../format.js';
import type { Tone } from '../labels.js';
import { usePersistentState, usePostAction } from '../vscode-context.js';

import {
  isConfigStatus,
  KIND_LABELS,
  KIND_ORDER,
  STATUS_INFO,
  STATUS_ORDER,
} from './config-labels.js';

export interface ConfigGroup {
  readonly kind: ConfigKind;
  readonly items: readonly ConfigItem[];
}

/** True when the item's name, path or link target contains the search text, ignoring case. */
export function matchesQuery(item: ConfigItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return (
    needle === '' ||
    [item.name, item.path ?? '', item.realPath ?? ''].some((field) =>
      field.toLowerCase().includes(needle),
    )
  );
}

/** Items grouped by kind in a fixed order, names sorted, empty groups dropped. */
export function groupItems(
  items: readonly ConfigItem[],
  status: ConfigStatus | 'all',
  query = '',
): readonly ConfigGroup[] {
  const shown = items.filter(
    (item) => (status === 'all' || item.status === status) && matchesQuery(item, query),
  );
  return KIND_ORDER.map((kind) => ({
    kind,
    items: shown
      .filter((item) => item.kind === kind)
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  })).filter((group) => group.items.length > 0);
}

/** Only items outside the repo can be adopted into it. */
export function canAdopt(item: ConfigItem): boolean {
  return item.status === 'local-only';
}

function isStatusFilter(value: unknown): value is ConfigStatus | 'all' {
  return value === 'all' || isConfigStatus(value);
}

/** One line on where the background sync is. */
export function syncLine(sync: ConfigSyncStatus, now: number): string {
  switch (sync.state) {
    case 'syncing': {
      return 'Syncing now.';
    }
    case 'error': {
      return sync.message ?? 'The last sync failed.';
    }
    case 'off': {
      return 'Background sync is off (overlord.configSync.auto).';
    }
    case 'idle': {
      return sync.lastSyncAt === null
        ? 'Not synced yet.'
        : `Synced ${formatAgo(sync.lastSyncAt, now)}.`;
    }
  }
}

function RepoStats(props: { readonly state: ConfigState }): ReactElement {
  const now = useNow();
  const { repo, sync } = props.state;
  return (
    <dl className="stats">
      <div className="stat">
        <dt>Sync</dt>
        <dd className={sync.state === 'error' ? 'error-text' : undefined}>{syncLine(sync, now)}</dd>
      </div>
      <div className="stat">
        <dt>Remote</dt>
        <dd className="mono">{repo.remote ?? 'none'}</dd>
      </div>
      <div className="stat">
        <dt>Path</dt>
        <dd className="mono">{repo.path ?? 'none'}</dd>
      </div>
      <div className="stat">
        <dt>Ahead</dt>
        <dd>{repo.ahead.toString()}</dd>
      </div>
      <div className="stat">
        <dt>Behind</dt>
        <dd>{repo.behind.toString()}</dd>
      </div>
      <div className="stat">
        <dt>Changed files</dt>
        <dd>{repo.dirty.toString()}</dd>
      </div>
    </dl>
  );
}

function repoTone(state: ConfigState): Tone {
  if (!state.repo.connected || state.sync.state === 'off') {
    return 'neutral';
  }
  if (state.sync.state === 'error') {
    return 'critical';
  }
  return state.repo.dirty > 0 || state.repo.ahead > 0 || state.repo.behind > 0 ? 'warning' : 'good';
}

function RepoCard(props: { readonly state: ConfigState }): ReactElement {
  const { repo } = props.state;
  const tone = repoTone(props.state);
  return (
    <div className={`card card-edge card-${tone} config-repo`}>
      <div className="card-head">
        <StatusDot tone={tone} />
        <span className="card-title">Config repo</span>
      </div>
      {repo.connected ? (
        <RepoStats state={props.state} />
      ) : (
        <p className="card-text">
          Config sync is off. Turning it on signs in to GitHub, finds your private overlord-config
          repo or creates one, and from then on keeps it in step with ~/.claude on every machine.
        </p>
      )}
    </div>
  );
}

function SyncButtons(props: { readonly state: ConfigState }): ReactElement {
  const post = usePostAction();
  const { repo, sync } = props.state;
  return repo.connected ? (
    <button
      type="button"
      className="primary"
      disabled={sync.state === 'syncing'}
      onClick={() => {
        post({ type: 'syncNow' });
      }}
    >
      Sync now
    </button>
  ) : (
    <button
      type="button"
      className="primary"
      onClick={() => {
        post({ type: 'turnOnSync' });
      }}
    >
      Turn on sync
    </button>
  );
}

function StatusLegend(): ReactElement {
  return (
    <details className="about">
      <summary>Badge legend</summary>
      <ul className="legend">
        {STATUS_ORDER.map((status) => (
          <li key={status}>
            <Badge label={STATUS_INFO[status].label} tone={STATUS_INFO[status].tone} />{' '}
            {STATUS_INFO[status].meaning}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ItemCard(props: { readonly item: ConfigItem }): ReactElement {
  const post = usePostAction();
  const { item } = props;
  const info = STATUS_INFO[item.status];
  const path = item.path;
  const attention = info.tone === 'warning' || info.tone === 'critical';
  return (
    <Card {...(attention ? { tone: info.tone } : {})} action={canAdopt(item)}>
      <div className="card-head">
        <span className="card-title" title={item.name}>
          {item.name}
        </span>
        <Badge label={info.label} tone={info.tone} title={info.meaning} />
      </div>
      <div className="config-path">
        {path === null ? (
          <span className="muted">none</span>
        ) : (
          <button
            type="button"
            className="link-button mono"
            title={path}
            onClick={() => {
              post({ type: 'openFile', path });
            }}
          >
            {path}
          </button>
        )}
      </div>
      {item.realPath === null ? null : (
        <p className="card-text config-link" title={item.realPath}>
          links to {item.realPath}
        </p>
      )}
      <div className="card-foot">
        <span className="chip">{item.scope}</span>
        <span className="spacer" />
        {canAdopt(item) ? (
          <button
            type="button"
            aria-label={`Adopt ${item.name} into repo`}
            onClick={() => {
              post({ type: 'adoptConfig', itemId: item.id });
            }}
          >
            Adopt
          </button>
        ) : null}
      </div>
    </Card>
  );
}

function Group(props: { readonly group: ConfigGroup }): ReactElement | null {
  const { group } = props;
  return (
    <CardGroup
      id={`config-${group.kind}`}
      title={KIND_LABELS[group.kind]}
      count={group.items.length}
    >
      {group.items.map((item) => (
        <ItemCard key={item.id} item={item} />
      ))}
    </CardGroup>
  );
}

export function ConfigView(props: { readonly state: ConfigState }): ReactElement {
  const { state } = props;
  const [status, setStatus] = usePersistentState('config.status', 'all', isStatusFilter);
  const [query, setQuery] = useState('');
  const groups = groupItems(state.items, status, query);
  const shown = groups.reduce((sum, group) => sum + group.items.length, 0);
  const total = state.items.length.toString();
  return (
    <section className="config" aria-labelledby="config-title">
      <header className="view-header">
        <h1 id="config-title">Config and sync</h1>
        <span className="muted">
          {shown === state.items.length
            ? `${total} items`
            : `${shown.toString()} of ${total} items`}
        </span>
        <span className="spacer" />
        <SyncButtons state={state} />
      </header>
      <RepoCard state={state} />
      <StatusLegend />
      <div className="list-bar" role="search">
        <input
          type="search"
          aria-label="Search"
          placeholder="Search by name or path"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <label>
          Status
          <select
            value={status}
            onChange={(event) => {
              const next = event.target.value;
              setStatus(isStatusFilter(next) ? next : 'all');
            }}
          >
            <option value="all">All</option>
            {STATUS_ORDER.map((entry) => (
              <option key={entry} value={entry}>
                {STATUS_INFO[entry].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {groups.length === 0 ? (
        <EmptyState title="No config items" />
      ) : (
        groups.map((group) => <Group key={group.kind} group={group} />)
      )}
    </section>
  );
}
