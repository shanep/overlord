// Every config item on the machine, grouped by kind, with its sync status
// and the config repo's state.

import type { ReactElement } from 'react';

import type { ConfigItem, ConfigKind, ConfigStatus } from '../../../src/shared/model.js';
import type { ConfigState } from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import { EmptyState } from '../components/empty-state.js';
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

/** Items grouped by kind in a fixed order, names sorted, empty groups dropped. */
export function groupItems(
  items: readonly ConfigItem[],
  status: ConfigStatus | 'all',
): readonly ConfigGroup[] {
  const shown = items.filter((item) => status === 'all' || item.status === status);
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

function RepoHeader(props: { readonly repo: ConfigState['repo'] }): ReactElement {
  const post = usePostAction();
  const { repo } = props;
  return (
    <div className="section">
      {repo.connected ? (
        <dl className="stats">
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
      ) : (
        <p className="muted">No config repo connected.</p>
      )}
      <div className="toolbar">
        <button
          type="button"
          disabled={!repo.connected}
          onClick={() => {
            post({ type: 'syncPush' });
          }}
        >
          Push
        </button>
        <button
          type="button"
          disabled={!repo.connected}
          onClick={() => {
            post({ type: 'syncPull' });
          }}
        >
          Pull
        </button>
        <span className="spacer" />
        <button
          type="button"
          onClick={() => {
            post({ type: 'newAgent' });
          }}
        >
          New agent
        </button>
        <button
          type="button"
          onClick={() => {
            post({ type: 'newSkill' });
          }}
        >
          New skill
        </button>
      </div>
    </div>
  );
}

function StatusLegend(): ReactElement {
  return (
    <details className="section">
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

function ItemRow(props: { readonly item: ConfigItem }): ReactElement {
  const post = usePostAction();
  const { item } = props;
  const info = STATUS_INFO[item.status];
  const path = item.path;
  return (
    <tr>
      <td>{item.name}</td>
      <td>{item.scope}</td>
      <td>
        <Badge label={info.label} tone={info.tone} title={info.meaning} />
      </td>
      <td className="wrap">
        {path === null ? (
          <span className="muted">none</span>
        ) : (
          <button
            type="button"
            className="link-button mono"
            onClick={() => {
              post({ type: 'openFile', path });
            }}
          >
            {path}
          </button>
        )}
        {item.realPath === null ? null : <span className="muted"> links to {item.realPath}</span>}
      </td>
      <td>
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
      </td>
    </tr>
  );
}

function GroupTable(props: { readonly group: ConfigGroup }): ReactElement {
  const { group } = props;
  const title = KIND_LABELS[group.kind];
  return (
    <details open className="section">
      <summary>
        {title} ({group.items.length.toString()})
      </summary>
      <table className="grid">
        <caption className="visually-hidden">{title}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Scope</th>
            <th scope="col">Status</th>
            <th scope="col">Path</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {group.items.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function ConfigView(props: { readonly state: ConfigState }): ReactElement {
  const { state } = props;
  const [status, setStatus] = usePersistentState('config.status', 'all', isStatusFilter);
  const groups = groupItems(state.items, status);
  return (
    <section aria-labelledby="config-title">
      <header className="view-header">
        <h1 id="config-title">Config and sync</h1>
        <span className="muted">{state.items.length.toString()} items</span>
      </header>
      <RepoHeader repo={state.repo} />
      <StatusLegend />
      <div className="toolbar">
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
        groups.map((group) => <GroupTable key={group.kind} group={group} />)
      )}
    </section>
  );
}
