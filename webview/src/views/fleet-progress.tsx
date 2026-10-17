// The progress cells of a Fleet row: how far along the session's own task
// list is, what it should take to finish, where its subagents spent their
// tokens, and its token budget. The bar opens the budget box.

import type { ReactElement } from 'react';

import type {
  BudgetUse,
  FleetProgress,
  SubagentBurn,
  TaskProgress,
} from '../../../src/shared/progress.js';
import { SOLID_BASIS } from '../../../src/shared/progress.js';
import { Badge } from '../components/badge.js';
import { Meter, meterTone } from '../components/meter.js';
import { formatClock, formatCompact, formatCost, formatPercent, plural } from '../format.js';

import type { RowEvent } from './fleet-actions.js';
import type { FleetRow } from './fleet-rows.js';

const MINUTE = 60_000;

/** 22m or 3h 10m: an estimate has no use for seconds. */
export function formatLeft(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) {
    return `${minutes.toString()}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours.toString()}h` : `${hours.toString()}h ${rest.toString()}m`;
}

/** 15:40, for when work should finish or a limit runs out. */
function timeOfDay(at: number): string {
  return formatClock(at).slice(0, 5);
}

function tasksTip(tasks: TaskProgress): string[] {
  const lines = [`${tasks.done.toString()} of ${plural(tasks.total, 'task')} done.`];
  if (tasks.inProgress > 0) {
    lines.push(`${tasks.inProgress.toString()} in progress.`);
  }
  if (tasks.current !== null) {
    lines.push(`Now: ${tasks.current}.`);
  }
  const { estimate } = tasks;
  if (estimate === null) {
    lines.push(tasks.done >= tasks.total ? 'All tasks done.' : 'No estimate until a task is done.');
    return lines;
  }
  const cost = estimate.costLeftUsd === null ? '' : ` (${formatCost(estimate.costLeftUsd)})`;
  lines.push(
    `About ${formatCompact(estimate.tokensLeft)} tokens${cost} and ${formatLeft(estimate.msLeft)} left, done around ${timeOfDay(estimate.finishAt)}.`,
  );
  if (estimate.basis < SOLID_BASIS) {
    lines.push(`Rough: it rests on ${plural(estimate.basis, 'finished task')}.`);
  }
  if (estimate.limitRunsOutAt !== null) {
    lines.push(
      `The 5 hour limit runs out at ${timeOfDay(estimate.limitRunsOutAt)} at the fleet's pace, before this is done.`,
    );
  }
  return lines;
}

function subagentsTip(burn: SubagentBurn): string {
  const top = burn.top
    .map(
      (spend) =>
        `${spend.description} ${formatCompact(spend.tokens)}${spend.running ? ' (running)' : ''}`,
    )
    .join(', ');
  return `Subagents: ${burn.running.toString()} running, ${burn.finished.toString()} finished, ${formatCompact(burn.tokens)} tokens. Most: ${top}.`;
}

function budgetTip(budget: BudgetUse | null): string {
  return budget === null
    ? 'Click to set a token budget.'
    : `Budget: ${formatCompact(budget.used)} of ${formatCompact(budget.tokens)} tokens used. Click to change it.`;
}

/** Everything the progress cells know, for their tooltip. */
export function progressTip(progress: FleetProgress | null): string {
  const tasks = progress?.tasks ?? null;
  const subagents = progress?.subagents ?? null;
  const lines = tasks === null ? [] : tasksTip(tasks);
  if (subagents !== null) {
    lines.push(subagentsTip(subagents));
  }
  lines.push(budgetTip(progress?.budget ?? null));
  return lines.join(' ');
}

/** True when the work left would take the session past its budget. */
function overBudget(progress: FleetProgress): boolean {
  const { budget, tasks } = progress;
  if (budget === null) {
    return false;
  }
  return budget.used + (tasks?.estimate?.tokensLeft ?? 0) > budget.tokens;
}

function ProgressMeter(props: { readonly progress: FleetProgress | null }): ReactElement {
  const { progress } = props;
  const tasks = progress?.tasks ?? null;
  if (tasks !== null) {
    return (
      <Meter
        label="Tasks done"
        ratio={tasks.done / tasks.total}
        tone={tasks.done >= tasks.total ? 'good' : 'info'}
        text={`${tasks.done.toString()}/${tasks.total.toString()}`}
      />
    );
  }
  const budget = progress?.budget ?? null;
  if (budget !== null) {
    const used = budget.used / budget.tokens;
    return (
      <Meter
        label="Budget used"
        ratio={used}
        tone={meterTone(used)}
        text={`${formatPercent(used)} budget`}
      />
    );
  }
  return <span className="progress-empty">Budget</span>;
}

/** A session's task progress, or its budget when it has no task list, as a button that sets the budget. */
export function ProgressCell(props: {
  readonly row: FleetRow;
  readonly tabIndex: number;
  readonly onAction: (row: FleetRow, action: RowEvent) => void;
}): ReactElement | null {
  const { row } = props;
  if (row.kind !== 'session') {
    return null;
  }
  return (
    <button
      type="button"
      className="health-bar progress-bar"
      tabIndex={props.tabIndex}
      data-tip={progressTip(row.progress)}
      aria-label={`Progress of ${row.title}: set its token budget`}
      onClick={() => {
        props.onAction(row, 'budget');
      }}
    >
      <ProgressMeter progress={row.progress} />
    </button>
  );
}

/** What is left: time and tokens, marked when the 5 hour limit or the budget runs out first. */
export function LeftCell(props: { readonly row: FleetRow }): ReactElement | null {
  const { progress } = props.row;
  const tasks = progress?.tasks ?? null;
  if (progress === null || tasks === null) {
    return null;
  }
  const tip = progressTip(progress);
  const { estimate } = tasks;
  if (estimate === null) {
    return (
      <span className="muted" data-tip={tip}>
        {tasks.done >= tasks.total ? 'Done' : 'Estimating'}
      </span>
    );
  }
  const rough = estimate.basis < SOLID_BASIS ? '~' : '';
  let warning: string | null = null;
  if (estimate.limitRunsOutAt !== null) {
    warning = 'Limit';
  } else if (overBudget(progress)) {
    warning = 'Over budget';
  }
  return (
    <span data-tip={tip}>
      {`${rough}${formatLeft(estimate.msLeft)} · ${formatCompact(estimate.tokensLeft)}`}
      {warning === null ? null : (
        <>
          {' '}
          <Badge label={warning} tone="warning" />
        </>
      )}
    </span>
  );
}
