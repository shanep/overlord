// Knobs: every documented setting, env var and flag with its effective value
// and where it came from, plus launch profiles and the cached feature flags.

import type { ReactElement } from 'react';

import type { KnobsState } from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import { EmptyState } from '../components/empty-state.js';
import { formatValue } from '../format.js';
import { isString, isStringArray } from '../guards.js';
import { usePersistentState } from '../vscode-context.js';

import { KnobRow } from './knobs-editor.js';
import { ProfilesEditor } from './knobs-profiles.js';
import { groupByArea } from './knobs-values.js';

export function FeatureFlags(props: {
  readonly flags: Readonly<Record<string, unknown>>;
}): ReactElement {
  const entries = Object.entries(props.flags).toSorted((a, b) => a[0].localeCompare(b[0]));
  return (
    <section className="section" aria-labelledby="flags-heading">
      <div className="toolbar">
        <h2 id="flags-heading">Feature flags</h2>
        <Badge label="read only" tone="warning" />
      </div>
      <p className="muted">
        Read only. Claude Code rewrites this cache from the server, so edits would not stick.
      </p>
      {entries.length === 0 ? (
        <p className="muted">No cached flags.</p>
      ) : (
        <table className="grid">
          <caption className="visually-hidden">Cached feature flags, read only</caption>
          <thead>
            <tr>
              <th scope="col">Flag</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key}>
                <td className="mono">{key}</td>
                <td className="mono wrap">{formatValue(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function KnobsView(props: { readonly state: KnobsState }): ReactElement {
  const { state } = props;
  const [query, setQuery] = usePersistentState('knobs.query', '', isString);
  const [expanded, setExpanded] = usePersistentState<readonly string[]>(
    'knobs.expanded',
    [],
    isStringArray,
  );
  const effective = new Map(state.effective.map((value) => [value.key, value]));
  const groups = groupByArea(state.catalog, query);
  const toggle = (key: string): void => {
    setExpanded(
      expanded.includes(key) ? expanded.filter((item) => item !== key) : [...expanded, key],
    );
  };
  return (
    <div>
      <div className="view-header">
        <h1>Knobs</h1>
        <span className="muted">{state.catalog.length} keys</span>
      </div>
      <div className="toolbar">
        <label>
          Search
          <input
            type="search"
            value={query}
            placeholder="key, area or text"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
      </div>
      {groups.length === 0 ? <EmptyState title="No knobs match." /> : null}
      {groups.map((group) => (
        <section key={group.area} className="section" aria-labelledby={`area-${group.area}`}>
          <h2 id={`area-${group.area}`}>{group.area}</h2>
          <ul className="feed">
            {group.knobs.map((definition) => (
              <KnobRow
                key={definition.key}
                definition={definition}
                effective={effective.get(definition.key)}
                expanded={expanded.includes(definition.key)}
                onToggle={toggle}
              />
            ))}
          </ul>
        </section>
      ))}
      <ProfilesEditor profiles={state.profiles} />
      <FeatureFlags flags={state.featureFlags} />
    </div>
  );
}
