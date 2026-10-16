// The help page: what every icon and badge means, where each view lives, and
// how a day with Overlord usually goes, how a session lives and ends, and a map of where Overlord can grow. Badges render with the real
// components, so the page cannot drift from what the other views show.

import type { ReactElement, ReactNode } from 'react';

import type { SessionPlace, SessionState, Surface } from '../../../src/shared/model.js';
import type { HandoffKind } from '../../../src/shared/protocol.js';
import {
  Badge,
  PlaceMarker,
  StateBadge,
  SurfaceBadge,
  WindowlessMarker,
} from '../components/badge.js';
import { Icon } from '../components/icon.js';
import { PLACE_INFO, STATE_INFO, SURFACES, WINDOWLESS_INFO } from '../labels.js';

import { STATUS_INFO, STATUS_ORDER } from './config-labels.js';
import type { Column, SidebarGroup } from './help-content.js';
import {
  FLEET_COLUMNS,
  FLEET_KEYS,
  FLEET_STATS,
  HANDOFF_MEANINGS,
  ROW_BUTTONS,
  SIDEBAR_GROUPS,
  SURFACE_MEANINGS,
  WORKFLOW,
} from './help-content.js';
import { ExtendSection } from './help-extend.js';
import { SessionsSection } from './help-sessions.js';
import { HANDOFF_LABELS } from './sessions-view.js';

const STATES: readonly SessionState[] = ['running', 'waiting', 'idle', 'done', 'failed', 'unknown'];
const PLACES: readonly SessionPlace[] = ['vscode', 'terminal', 'background'];
const HANDOFFS: readonly HandoffKind[] = [
  'resume-local',
  'open-desktop',
  'teleport-local',
  'remote-control',
];

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
      <ol className="help-steps">
        {WORKFLOW.map((step) => (
          <li key={step.title}>
            <strong>{step.title}.</strong> {step.detail}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function SessionIcons(): ReactElement {
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
        intro="Which Claude product a session came from."
      >
        <MeaningTable
          label="Surfaces"
          heading="Badge"
          rows={SURFACES.map((surface: Surface): Row => [
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

function OtherBadges(): ReactElement {
  return (
    <>
      <Section
        id="help-handoffs"
        title="Handoff buttons"
        intro="In All Sessions. Each session only gets the buttons that make sense for its surface."
      >
        <MeaningTable
          label="Handoff buttons"
          heading="Button"
          rows={HANDOFFS.map((kind): Row => [kind, HANDOFF_LABELS[kind], HANDOFF_MEANINGS[kind]])}
        />
      </Section>
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

export function HelpView(): ReactElement {
  return (
    <article className="help" aria-labelledby="help-title">
      <header className="view-header">
        <h1 id="help-title">Overlord help</h1>
      </header>
      <p>
        Overlord is htop for Claude Code. It shows every session and subagent you have running, what
        is in their context, and every knob you can turn. It also runs agents itself, so you can
        launch a batch of prompts and watch them side by side.
      </p>
      <WorkflowSection />
      <SessionsSection />
      <Section
        id="help-sidebar"
        title="The sidebar"
        intro="Click the Overlord icon in the activity bar. It has three sections."
      >
        {SIDEBAR_GROUPS.map((group) => (
          <SidebarTable key={group.title} group={group} />
        ))}
      </Section>
      <SessionIcons />
      <FleetHelp />
      <OtherBadges />
      <ExtendSection />
    </article>
  );
}
