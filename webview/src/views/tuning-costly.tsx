// The parts of the Tuning view that take the spend apart: where it went
// across every session, the fixes a tip can apply, the most expensive
// sessions with their causes, and the files sessions keep paying to carry.

import type { ReactElement } from 'react';

import type { AutoFix, CostlySession, HotFile, SpendSlice } from '../../../src/shared/tuning.js';
import { Badge } from '../components/badge.js';
import { Card, CardGroup, StatusDot } from '../components/card.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { Meter } from '../components/meter.js';
import { formatCompact, formatCost, formatInteger, formatPercent, formatUsd } from '../format.js';
import { usePostAction } from '../vscode-context.js';

function SpendBars(props: {
  readonly label: string;
  readonly slices: readonly SpendSlice[];
  readonly limit?: number;
}): ReactElement {
  const slices = props.slices.slice(0, props.limit ?? props.slices.length);
  return (
    <ul className="spend-bars" aria-label={props.label}>
      {slices.map((slice) => (
        <li key={slice.source}>
          <span className="spend-label">{slice.label}</span>
          <Meter
            label={slice.label}
            ratio={slice.share}
            tone="info"
            text={`${formatUsd(slice.usd)} · ${formatPercent(slice.share)}`}
          />
        </li>
      ))}
    </ul>
  );
}

export function SpendSection(props: {
  readonly slices: readonly SpendSlice[];
}): ReactElement | null {
  if (props.slices.length === 0) {
    return null;
  }
  return (
    <section className="section spend" aria-labelledby="tuning-spend">
      <h2 id="tuning-spend">Where the money went</h2>
      <p className="muted">
        Every request sends the whole context again, so each thing below is charged once per request
        it stayed in context for. Main threads and subagents together.
      </p>
      <SpendBars label="Spend by what filled the context" slices={props.slices} />
    </section>
  );
}

const FIX_BUTTONS: Readonly<Record<AutoFix['kind'], string>> = {
  knob: 'Set it',
  create: 'Create',
  launch: 'Start session',
};

function FixRow(props: { readonly fix: AutoFix }): ReactElement {
  const { fix } = props;
  const post = usePostAction();
  const apply = (): void => {
    if (fix.kind === 'knob') {
      post({ type: 'setKnob', key: fix.key, value: fix.value, layer: 'user' });
    } else if (fix.kind === 'create') {
      post({ type: 'createSuggestion', suggestionId: fix.suggestionId });
    } else {
      post({
        type: 'launch',
        specs: [
          {
            prompt: fix.prompt,
            cwd: fix.cwd,
            profileId: null,
            worktree: fix.worktree,
            maxBudgetUsd: null,
            label: fix.label,
          },
        ],
      });
    }
  };
  return (
    <li className="auto-fix">
      <div className="auto-fix-text">
        <span className="auto-fix-title">{fix.title}</span>
        <span className="card-text">{fix.detail}</span>
      </div>
      {fix.applied ? (
        <Badge label="Done" tone="good" />
      ) : (
        <button type="button" onClick={apply} aria-label={`${FIX_BUTTONS[fix.kind]}: ${fix.title}`}>
          {FIX_BUTTONS[fix.kind]}
        </button>
      )}
    </li>
  );
}

/** The fixes Overlord applies for a tip, each with its button. */
export function AutoFixList(props: {
  readonly label: string;
  readonly fixes: readonly AutoFix[];
}): ReactElement | null {
  if (props.fixes.length === 0) {
    return null;
  }
  return (
    <ul className="auto-fixes" aria-label={props.label}>
      {props.fixes.map((fix) => (
        <FixRow key={fix.id} fix={fix} />
      ))}
    </ul>
  );
}

function CostlyCard(props: {
  readonly session: CostlySession;
  readonly tips: ReadonlyMap<string, string>;
}): ReactElement {
  const { session } = props;
  const post = usePostAction();
  return (
    <Card tone="warning">
      <div className="card-head">
        <StatusDot tone="warning" />
        <div className="card-titles">
          <button
            type="button"
            className="link-button card-title"
            title="Open the agent view for this session"
            onClick={() => {
              post({ type: 'openAgent', sessionId: session.sessionId, agentId: session.sessionId });
            }}
          >
            {session.title}
          </button>
          <span className="card-sub">
            {`${formatInteger(session.requests)} requests · ${formatCompact(session.averageContext)} average context · ${formatCompact(session.peakContext)} peak`}
          </span>
        </div>
        <Badge label={formatCost(session.usd)} tone="warning" />
      </div>
      <SpendBars label={`Where ${session.title} spent`} slices={session.spend} limit={4} />
      <ul className="costly-causes" aria-label={`Why ${session.title} cost so much`}>
        {session.causes.map((cause) => (
          <li key={cause.id}>
            {cause.text}
            {cause.tipId === null || !props.tips.has(cause.tipId) ? null : (
              <span className="chip">{`Fix: ${props.tips.get(cause.tipId) ?? ''}`}</span>
            )}
          </li>
        ))}
      </ul>
      {session.heavy.length === 0 ? null : (
        <details>
          <summary>What cost the most to carry</summary>
          <ul className="props-list" aria-label={`What ${session.title} carried`}>
            {session.heavy.map((item) => (
              <li key={`${item.label}-${String(item.usd)}`}>
                <code>{item.label}</code>{' '}
                <span className="muted">
                  {`${formatCompact(item.tokens)} tokens, ${formatCost(item.usd)}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {session.subagents.length === 0 ? null : (
        <details>
          <summary>{`Subagents, ${formatCost(session.subagentUsd)}`}</summary>
          <ul className="props-list" aria-label={`Subagents of ${session.title}`}>
            {session.subagents.map((agent, index) => (
              <li key={`${agent.description}-${String(index)}`}>
                {agent.description === '' ? agent.type : agent.description}{' '}
                <span className="muted">
                  {`${agent.type}, ${formatInteger(agent.requests)} requests, ${formatCompact(agent.peakContext)} peak, ${formatCost(agent.usd)}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

export function CostlySessions(props: {
  readonly sessions: readonly CostlySession[];
  readonly tips: ReadonlyMap<string, string>;
}): ReactElement | null {
  return (
    <CardGroup
      id="tuning-costly"
      title="Most expensive sessions"
      count={props.sessions.length}
      wide
    >
      {props.sessions.map((session) => (
        <CostlyCard key={session.sessionId} session={session} tips={props.tips} />
      ))}
    </CardGroup>
  );
}

function lastPart(folder: string): string {
  return folder.split('/').findLast((part) => part !== '') ?? folder;
}

const HOT_COLUMNS: readonly Column<HotFile>[] = [
  {
    id: 'path',
    header: 'File',
    cell: (row) => <code>{row.path}</code>,
    sortValue: (row) => row.path,
    wrap: true,
  },
  {
    id: 'project',
    header: 'Project',
    cell: (row) => <span title={row.project}>{lastPart(row.project)}</span>,
    sortValue: (row) => row.project,
    drop: 2,
  },
  {
    id: 'sessions',
    header: 'Sessions',
    cell: (row) => formatInteger(row.sessions),
    sortValue: (row) => row.sessions,
    numeric: true,
  },
  {
    id: 'usd',
    header: 'Cost to carry',
    cell: (row) => formatCost(row.usd),
    sortValue: (row) => row.usd,
    numeric: true,
  },
];

export function HotFiles(props: { readonly files: readonly HotFile[] }): ReactElement | null {
  if (props.files.length === 0) {
    return null;
  }
  return (
    <details className="panel">
      <summary>
        <h2 id="tuning-hot-files">Files sessions keep paying for</h2>{' '}
        <span className="muted">{formatInteger(props.files.length)}</span>
      </summary>
      <div className="table-card">
        <DataTable
          caption="Files sessions keep paying for"
          columns={HOT_COLUMNS}
          rows={props.files}
          rowKey={(row) => `${row.project}/${row.path}`}
          empty="No file reads measured yet."
        />
      </div>
    </details>
  );
}
