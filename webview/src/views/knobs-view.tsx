// Knobs: every documented setting, env var and CLI flag, grouped by area, with
// its effective value and where it came from and a way to change it. Tabs hold
// the launch profiles and the cached feature flags.

import type { ReactElement } from 'react';

import type { KnobsState } from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import { EmptyState } from '../components/empty-state.js';
import { formatValue } from '../format.js';
import { isBoolean, isString, isStringArray } from '../guards.js';
import { usePersistentState } from '../vscode-context.js';

import { knobEntries, unlistedDefinition, unlistedEffective } from './knobs-match.js';
import { ProfilesEditor } from './knobs-profiles.js';
import type { RowProps } from './knobs-sections.js';
import { AreaSection, SettingsFiles, UnlistedSection } from './knobs-sections.js';
import type { KindFilter, KnobEntry, KnobFilter } from './knobs-values.js';
import { groupEntries, isKindFilter, isSet, KIND_FILTERS, matchesQuery } from './knobs-values.js';

type KnobsTab = 'keys' | 'profiles' | 'flags';

const TABS: ReadonlySet<unknown> = new Set(['keys', 'profiles', 'flags']);

function isKnobsTab(value: unknown): value is KnobsTab {
  return TABS.has(value);
}

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

function PressButton(props: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onPress: () => void;
}): ReactElement {
  return (
    <button type="button" className="press" aria-pressed={props.pressed} onClick={props.onPress}>
      {props.label}
    </button>
  );
}

function toggled(list: readonly string[], item: string): readonly string[] {
  return list.includes(item) ? list.filter((other) => other !== item) : [...list, item];
}

function KeysTab(props: {
  readonly state: KnobsState;
  readonly entries: readonly KnobEntry[];
}): ReactElement {
  const { state, entries } = props;
  const [query, setQuery] = usePersistentState('knobs.query', '', isString);
  const [kind, setKind] = usePersistentState<KindFilter>('knobs.kind', 'all', isKindFilter);
  const [onlySet, setOnlySet] = usePersistentState('knobs.onlySet', false, isBoolean);
  const [showRetired, setShowRetired] = usePersistentState('knobs.showRetired', false, isBoolean);
  const [expanded, setExpanded] = usePersistentState<readonly string[]>(
    'knobs.expanded',
    [],
    isStringArray,
  );
  const [openAreas, setOpenAreas] = usePersistentState<readonly string[]>(
    'knobs.openAreas',
    [],
    isStringArray,
  );
  const filter: KnobFilter = { query, kind, onlySet, showRetired };
  const groups = groupEntries(entries, filter);
  const unlisted = unlistedEffective(state.catalog, state.effective).filter(
    (value) =>
      (kind === 'all' || (kind === 'env') === value.key.startsWith('env.')) &&
      matchesQuery(unlistedDefinition(value), query),
  );
  const showUnlisted = kind !== 'flag';
  // Searching or narrowing to what is set opens every area, so matches are never hidden.
  const forceOpen = query.trim() !== '' || onlySet;
  const rows: RowProps = {
    profiles: state.profiles,
    expanded,
    onToggle: (key) => {
      setExpanded(toggled(expanded, key));
    },
  };
  return (
    <div>
      <SettingsFiles files={state.files} />
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
        <div role="group" aria-label="Kind" className="chips">
          {KIND_FILTERS.map((item) => (
            <PressButton
              key={item.value}
              label={item.label}
              pressed={kind === item.value}
              onPress={() => {
                setKind(item.value);
              }}
            />
          ))}
        </div>
        <label>
          <input
            type="checkbox"
            checked={onlySet}
            onChange={(event) => {
              setOnlySet(event.target.checked);
            }}
          />{' '}
          Only what is set
        </label>
        <label>
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(event) => {
              setShowRetired(event.target.checked);
            }}
          />{' '}
          Include removed keys
        </label>
      </div>
      {groups.length === 0 ? <EmptyState title="No knobs match." /> : null}
      {groups.map((group) => (
        <AreaSection
          key={group.area}
          group={group}
          open={forceOpen || openAreas.includes(group.area)}
          onToggleArea={(area) => {
            setOpenAreas(toggled(openAreas, area));
          }}
          rows={rows}
        />
      ))}
      {showUnlisted ? <UnlistedSection values={unlisted} rows={rows} /> : null}
    </div>
  );
}

export function KnobsView(props: { readonly state: KnobsState }): ReactElement {
  const { state } = props;
  const [tab, setTab] = usePersistentState<KnobsTab>('knobs.tab', 'keys', isKnobsTab);
  const entries = knobEntries(state.catalog, state.effective, state.profiles);
  const setCount = entries.filter((entry) => isSet(entry)).length;
  const tabs: readonly { readonly id: KnobsTab; readonly label: string }[] = [
    { id: 'keys', label: 'Keys' },
    { id: 'profiles', label: `Launch profiles (${String(state.profiles.length)})` },
    { id: 'flags', label: `Feature flags (${String(Object.keys(state.featureFlags).length)})` },
  ];
  return (
    <div>
      <div className="view-header">
        <h1>Knobs</h1>
        <span className="muted">
          {state.catalog.length} keys, {setCount} set
        </span>
      </div>
      <div role="group" aria-label="Knobs sections" className="chips">
        {tabs.map((item) => (
          <PressButton
            key={item.id}
            label={item.label}
            pressed={tab === item.id}
            onPress={() => {
              setTab(item.id);
            }}
          />
        ))}
      </div>
      {tab === 'keys' ? <KeysTab state={state} entries={entries} /> : null}
      {tab === 'profiles' ? <ProfilesEditor profiles={state.profiles} /> : null}
      {tab === 'flags' ? <FeatureFlags flags={state.featureFlags} /> : null}
    </div>
  );
}
