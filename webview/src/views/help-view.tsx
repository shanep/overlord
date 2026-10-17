// The help page: what every icon and badge means, where each view lives, how
// a day with Overlord usually goes, what works for each agent CLI, how a
// Claude Code session lives and ends, and a map of where Overlord can grow.
// Badges render with the real components, so the page cannot drift from what
// the other views show. A section about something only some agents can do
// shows only when a known agent can do it. The search box in the header cuts
// the page down to what matches (help-search.ts).

import type { ReactElement, ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

import type { AgentInfo } from '../../../src/shared/agents.js';
import type { SessionPlace, SessionState, Surface } from '../../../src/shared/model.js';
import { knownAgents, useAgents } from '../agents.js';
import {
  Badge,
  PlaceMarker,
  StateBadge,
  SurfaceBadge,
  WindowlessMarker,
} from '../components/badge.js';
import { Card } from '../components/card.js';
import { Icon } from '../components/icon.js';
import { PLACE_INFO, STATE_INFO, WINDOWLESS_INFO } from '../labels.js';

import { STATUS_INFO, STATUS_ORDER } from './config-labels.js';
import { AgentsSection, CLAUDE_SESSIONS_ID } from './help-agents.js';
import type { Column, SidebarGroup } from './help-content.js';
import {
  FLEET_COLUMNS,
  FLEET_KEYS,
  FLEET_STATS,
  HANDOFF_MEANINGS,
  SIDEBAR_GROUPS,
  SURFACE_MEANINGS,
  WORKFLOW,
} from './help-content.js';
import { ExtendSection } from './help-extend.js';
import {
  agentNames,
  HANDOFFS_ID,
  offeredHandoffs,
  shownSurfaces,
  skippedSections,
} from './help-gates.js';
import { ROW_BUTTONS } from './help-row-buttons.js';
import { SCREEN_MAP_ID, ScreenSection } from './help-screen.js';
import { SearchBox } from './help-search-box.js';
import { searchHelp } from './help-search.js';
import { SessionsSection } from './help-sessions.js';
import { HANDOFF_LABELS } from './sessions-view.js';

const STATES: readonly SessionState[] = ['running', 'waiting', 'idle', 'done', 'failed', 'unknown'];
const PLACES: readonly SessionPlace[] = ['vscode', 'terminal', 'background'];

type Row = readonly [key: string, first: ReactNode, meaning: string];

function Section(props: {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="section help-section" aria-labelledby={props.id}>
      <h2 id={props.id}>{props.title}</h2>
      <p className="muted">{props.intro}</p>
      {props.children}
    </section>
  );
}

/** A two column table: the thing on the left, what it means on the right. */
function MeaningTable(props: {
  readonly label: string;
  readonly heading: string;
  readonly rows: readonly Row[];
}): ReactElement {
  return (
    <table className="grid help-table" aria-label={props.label}>
      <thead>
        <tr>
          <th scope="col">{props.heading}</th>
          <th scope="col" className="wrap">
            Meaning
          </th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map(([key, first, meaning]) => (
          <tr key={key}>
            <td className="help-key">{first}</td>
            <td className="wrap">{meaning}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function columnRows(columns: readonly Column[]): readonly Row[] {
  return columns.map((column): Row => [column.name, column.name, column.meaning]);
}

function SidebarTable(props: { readonly group: SidebarGroup }): ReactElement {
  const { group } = props;
  return (
    <>
      <h3>{group.title}</h3>
      <p className="muted">{group.about}</p>
      <table className="grid help-table" aria-label={`${group.title} entries`}>
        <thead>
          <tr>
            <th scope="col">Entry</th>
            <th scope="col">Icon</th>
            <th scope="col" className="wrap">
              What it does
            </th>
          </tr>
        </thead>
        <tbody>
          {group.entries.map((entry) => (
            <tr key={entry.name}>
              <td className="help-key">{entry.name}</td>
              <td>{entry.icon}</td>
              <td className="wrap">{entry.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function WorkflowSection(): ReactElement {
  return (
    <Section
      id="help-workflow"
      title="A typical workflow"
      intro="How a day with Overlord usually goes, from setup to merged work."
    >
      <ol className="card-grid card-grid-wide help-steps">
        {WORKFLOW.map((step, index) => (
          <Card key={step.title}>
            <div className="card-head">
              <span className="help-step-number" aria-hidden="true">
                {String(index + 1)}
              </span>
              <strong className="card-title">{step.title}.</strong>
            </div>
            <p className="help-step-text">{step.detail}</p>
          </Card>
        ))}
      </ol>
    </Section>
  );
}

function SessionIcons(props: { readonly agents: readonly AgentInfo[] }): ReactElement {
  return (
    <>
      <Section
        id="help-states"
        title="Session states"
        intro="Every session and agent shows one of these. The glyph means the state never depends on color alone."
      >
        <MeaningTable
          label="Session states"
          heading="State"
          rows={STATES.map((state): Row => [
            state,
            <StateBadge key={state} state={state} />,
            STATE_INFO[state].description,
          ])}
        />
      </Section>
      <Section
        id="help-places"
        title="Where a session runs"
        intro="The small icons before a session's title. Only sessions with a running process get a place. A session open in a terminal stays in the fleet however quiet it gets, and closing the terminal lets it go."
      >
        <MeaningTable
          label="Where a session runs"
          heading="Icon"
          rows={[
            ...PLACES.map((place): Row => [
              place,
              <span key={place} className="help-pair">
                <PlaceMarker place={place} />
                {PLACE_INFO[place].label}
              </span>,
              `${PLACE_INFO[place].description}.`,
            ]),
            [
              'windowless',
              <span key="windowless" className="help-pair">
                <WindowlessMarker />
                {WINDOWLESS_INFO.label}
              </span>,
              `${WINDOWLESS_INFO.description}.`,
            ],
          ]}
        />
      </Section>
      <Section
        id="help-surfaces"
        title="Surfaces"
        intro="Where a session came from. Any agent can run in a terminal or the Launcher, and the rest are Claude products."
      >
        <MeaningTable
          label="Surfaces"
          heading="Badge"
          rows={shownSurfaces(props.agents).map((surface: Surface): Row => [
            surface,
            <SurfaceBadge key={surface} surface={surface} />,
            SURFACE_MEANINGS[surface],
          ])}
        />
      </Section>
    </>
  );
}

function FleetHelp(): ReactElement {
  return (
    <Section
      id="help-fleet"
      title="The Fleet"
      intro="Click a session to open it where it runs: its VS Code terminal tab, or a new tab attached to a background session. Anything else, and every subagent, opens the agent view. When you switch terminal tabs, the Fleet selects the session in the one you are on. When you come back to a window, its Fleet selects the session that ran in that window's folder. The buttons at the end of a row show up when you hover it or select it. Subagent rows only have Agent view. Interrupt and Stop are greyed out once a session has ended."
    >
      <MeaningTable
        label="Fleet row buttons"
        heading="Button"
        rows={ROW_BUTTONS.map((button): Row => [
          button.name,
          <span key={button.name} className="help-pair">
            <Icon name={button.icon} />
            {button.name}
          </span>,
          button.meaning,
        ])}
      />
      <MeaningTable
        label="Fleet row markers"
        heading="Marker"
        rows={[
          ['collapsed', '▸', 'The row has subagents. Click it to show them.'],
          ['expanded', '▾', 'The subagents are showing. Click it to hide them.'],
        ]}
      />
      <h3>Header</h3>
      <MeaningTable label="Fleet header" heading="Tile" rows={columnRows(FLEET_STATS)} />
      <h3>Columns</h3>
      <p className="muted">Click a column header to sort by it. The sidebar shows fewer columns.</p>
      <MeaningTable label="Fleet columns" heading="Column" rows={columnRows(FLEET_COLUMNS)} />
      <h3>Keys</h3>
      <MeaningTable
        label="Fleet keys"
        heading="Key"
        rows={FLEET_KEYS.map((key): Row => [
          key.keys.join(' '),
          <span key={key.meaning} className="help-pair">
            {key.keys.map((name) => (
              <kbd key={name}>{name}</kbd>
            ))}
          </span>,
          key.meaning,
        ])}
      />
    </Section>
  );
}

function OtherBadges(props: { readonly agents: readonly AgentInfo[] }): ReactElement {
  const handoffs = offeredHandoffs(props.agents);
  return (
    <>
      {handoffs.length === 0 ? null : (
        <Section
          id={HANDOFFS_ID}
          title="Handoff buttons"
          intro="In All Sessions. Each session only gets the buttons its agent and surface allow."
        >
          <MeaningTable
            label="Handoff buttons"
            heading="Button"
            rows={handoffs.map((kind): Row => [kind, HANDOFF_LABELS[kind], HANDOFF_MEANINGS[kind]])}
          />
        </Section>
      )}
      <Section
        id="help-config"
        title="Config badges"
        intro="In Config and Sync. Each badge says where a config item lives and whether the config repo has it."
      >
        <MeaningTable
          label="Config badges"
          heading="Badge"
          rows={STATUS_ORDER.map((status): Row => [
            status,
            <Badge
              key={status}
              label={STATUS_INFO[status].label}
              tone={STATUS_INFO[status].tone}
            />,
            STATUS_INFO[status].meaning,
          ])}
        />
      </Section>
    </>
  );
}

/** The sections in page order, for the links at the top. */
const CONTENTS: readonly (readonly [id: string, title: string])[] = [
  ['help-workflow', 'A typical workflow'],
  ['help-agents', 'Agents'],
  [SCREEN_MAP_ID, 'Where things are'],
  [CLAUDE_SESSIONS_ID, 'How a Claude Code session works'],
  ['help-sidebar', 'The sidebar'],
  ['help-states', 'Session states'],
  ['help-places', 'Where a session runs'],
  ['help-surfaces', 'Surfaces'],
  ['help-fleet', 'The Fleet'],
  ['help-handoffs', 'Handoff buttons'],
  ['help-config', 'Config badges'],
  ['help-extend', 'Extending Overlord'],
];

/**
 * The contents, without the sections no known agent needs, cut down to the
 * sections a search left showing.
 */
function Contents(props: {
  readonly shown: ReadonlySet<string> | null;
  readonly skipped: ReadonlySet<string>;
}): ReactElement {
  const { shown, skipped } = props;
  const listed = CONTENTS.filter(([id]) => !skipped.has(id) && (shown === null || shown.has(id)));
  return (
    <nav className="help-toc" aria-label="On this page">
      <span className="muted">On this page</span>
      <ul>
        {listed.map(([id, title]) => (
          <li key={id}>
            <a href={`#${id}`}>{title}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function HelpView(): ReactElement {
  const page = useRef<HTMLElement>(null);
  // The list from the host keeps its identity between renders, so the search reruns only when it changes.
  const sent = useAgents();
  const agents = knownAgents(sent);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<ReadonlySet<string> | null>(null);
  const skipped = skippedSections(agents);
  useLayoutEffect(() => {
    if (page.current !== null) {
      const sections = searchHelp(page.current, query);
      setShown(query.trim() === '' ? null : sections);
    }
  }, [query, sent]);
  return (
    <article ref={page} className="help" aria-labelledby="help-title">
      <header className="view-header">
        <h1 id="help-title">Overlord help</h1>
        <span className="spacer" />
        <SearchBox query={query} onChange={setQuery} />
      </header>
      <p className="help-lede">
        Overlord runs a fleet of coding agents from VS Code. It watches and starts sessions of{' '}
        {agentNames(agents)}, launches a batch of prompts side by side, each in its own git
        worktree, and shows every session and subagent you have running, what is in their context,
        and every knob you can turn.
      </p>
      <Contents shown={shown} skipped={skipped} />
      {shown?.size === 0 ? (
        <p className="empty-line muted" role="status">
          Nothing in help matches &quot;{query.trim()}&quot;.
        </p>
      ) : null}
      <WorkflowSection />
      <AgentsSection />
      <ScreenSection />
      {skipped.has(CLAUDE_SESSIONS_ID) ? null : <SessionsSection />}
      <Section
        id="help-sidebar"
        title="The sidebar"
        intro="Click the Overlord icon in the activity bar. It has three sections."
      >
        {SIDEBAR_GROUPS.map((group) => (
          <SidebarTable key={group.title} group={group} />
        ))}
      </Section>
      <SessionIcons agents={agents} />
      <FleetHelp />
      <OtherBadges agents={agents} />
      <ExtendSection />
    </article>
  );
}
