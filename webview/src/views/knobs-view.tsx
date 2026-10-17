// Knobs: every documented setting, env var and CLI flag of one agent, grouped
// by area, with its effective value and where it came from and a way to
// change it. A pick in the header switches agents when more than one has
// knobs. Tabs hold the launch profiles and Claude Code's cached feature flags.

import type { ReactElement } from 'react';

import type { AgentId } from '../../../src/shared/agents.js';
import { CLAUDE_CODE } from '../../../src/shared/agents.js';
import type { KnobsState } from '../../../src/shared/protocol.js';
import { findAgent, knowsClaude, useAgents } from '../agents.js';
import { Badge } from '../components/badge.js';
import type { SegmentedOption } from '../components/card.js';
import { Segmented } from '../components/card.js';
import { EmptyState } from '../components/empty-state.js';
import { formatValue } from '../format.js';
import { isBoolean, isString, isStringArray } from '../guards.js';
import { usePersistentState, usePostAction } from '../vscode-context.js';

import { knobEntries, unlistedDefinition, unlistedEffective } from './knobs-match.js';
import { ProfilesEditor } from './knobs-profiles.js';
import type { KnobsWords, RowProps } from './knobs-sections.js';
import { AreaSection, SettingsFiles, UnlistedSection } from './knobs-sections.js';
import type { KnobsTarget } from './knobs-target.js';
import { KnobsTargetContext } from './knobs-target.js';
import type { KindFilter, KnobEntry, KnobFilter } from './knobs-values.js';
import {
  areaNames,
  groupEntries,
  isKindFilter,
  isSet,
  KIND_FILTERS,
  matchesQuery,
} from './knobs-values.js';

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
      <h2 id="flags-heading" className="section-title">
        Feature flags <Badge label="read only" tone="warning" />
      </h2>
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

function toggled(list: readonly string[], item: string): readonly string[] {
  return list.includes(item) ? list.filter((other) => other !== item) : [...list, item];
}

function KeysTab(props: {
  readonly state: KnobsState;
  readonly entries: readonly KnobEntry[];
  /** The launch profiles of the agent shown, which its flags can go in. */
  readonly profiles: KnobsState['profiles'];
  readonly words: KnobsWords;
}): ReactElement {
  const { state, entries, words } = props;
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
  // Claude Code's area summaries name its own keys, so another agent's use plainer words.
  const names = areaNames(
    (state.agent ?? CLAUDE_CODE) === CLAUDE_CODE ? null : state.instructionsFile,
  );
  const groups = groupEntries(entries, filter, names);
  const unlisted = unlistedEffective(state.catalog, state.effective).filter(
    (value) =>
      (kind === 'all' || (kind === 'env') === value.key.startsWith('env.')) &&
      matchesQuery(unlistedDefinition(value), query, names),
  );
  const showUnlisted = kind !== 'flag';
  // Searching or narrowing to what is set opens every area, so matches are never hidden.
  const forceOpen = query.trim() !== '' || onlySet;
  const rows: RowProps = {
    profiles: props.profiles,
    expanded,
    onToggle: (key) => {
      setExpanded(toggled(expanded, key));
    },
  };
  return (
    <div>
      <SettingsFiles files={state.files} words={words} />
      <div className="list-bar knob-filters">
        <label className="knob-search">
          <span className="visually-hidden">Search</span>
          <input
            type="search"
            value={query}
            placeholder="Search keys, areas or descriptions"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
        <Segmented label="Kind" options={KIND_FILTERS} value={kind} onChange={setKind} />
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
      {showUnlisted ? (
        <UnlistedSection
          values={unlisted}
          rows={rows}
          words={words}
          envInSettings={state.envInSettings}
        />
      ) : null}
    </div>
  );
}

/** Which agent's knobs the view shows, when more than one agent has knobs. */
function AgentPick(props: {
  readonly listed: readonly AgentId[];
  readonly value: AgentId;
}): ReactElement | null {
  const post = usePostAction();
  const agents = useAgents();
  if (props.listed.length < 2) {
    return null;
  }
  return (
    <Segmented
      label="Agent"
      options={props.listed.map((id) => ({ value: id, label: findAgent(agents, id).name }))}
      value={props.value}
      onChange={(agent) => {
        post({ type: 'pickKnobsAgent', agent });
      }}
    />
  );
}

export function KnobsView(props: { readonly state: KnobsState }): ReactElement {
  const { state } = props;
  const agents = useAgents();
  const agentId = state.agent ?? CLAUDE_CODE;
  const agent = findAgent(agents, agentId);
  const [saved, setTab] = usePersistentState<KnobsTab>('knobs.tab', 'keys', isKnobsTab);
  // The feature flags are Claude Code's server cache, so the tab needs Claude Code shown.
  const flags = agentId === CLAUDE_CODE && knowsClaude(agents);
  const tab = saved === 'flags' && !flags ? 'keys' : saved;
  // A flag goes in a profile of the agent that takes it.
  const profiles = state.profiles.filter((profile) => profile.agent === agentId);
  const entries = knobEntries(state.catalog, state.effective, profiles);
  const target: KnobsTarget = { agent: agentId, layers: state.writableLayers };
  const words: KnobsWords = {
    name: agent.name,
    short: agent.short,
    settingsFile: state.settingsFile,
  };
  const setCount = entries.filter((entry) => isSet(entry)).length;
  const tabs: readonly SegmentedOption<KnobsTab>[] = [
    { value: 'keys', label: 'Keys' },
    { value: 'profiles', label: `Launch profiles (${String(state.profiles.length)})` },
    ...(flags
      ? [
          {
            value: 'flags',
            label: `Feature flags (${String(Object.keys(state.featureFlags).length)})`,
          } satisfies SegmentedOption<KnobsTab>,
        ]
      : []),
  ];
  return (
    <KnobsTargetContext value={target}>
      <div className="knobs">
        <header className="view-header">
          <h1>Knobs</h1>
          <AgentPick listed={state.knobAgents} value={agentId} />
          <span className="muted">
            {state.catalog.length} keys, {setCount} set
          </span>
          <span className="spacer" />
          <Segmented label="Knobs sections" options={tabs} value={tab} onChange={setTab} />
        </header>
        {tab === 'keys' ? (
          <KeysTab state={state} entries={entries} profiles={profiles} words={words} />
        ) : null}
        {tab === 'profiles' ? <ProfilesEditor profiles={state.profiles} agent={agentId} /> : null}
        {tab === 'flags' ? <FeatureFlags flags={state.featureFlags} /> : null}
      </div>
    </KnobsTargetContext>
  );
}
