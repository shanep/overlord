// Pure helpers for the launcher: budget parsing and turning the form into
// one launch spec per selected profile (a matrix run).

import type { LaunchProfile, LaunchSpec } from '../../../src/shared/model.js';
import type { LaunchRun } from '../../../src/shared/protocol.js';
import { formatUsd, truncate } from '../format.js';
import type { Tone } from '../labels.js';

export type BudgetResult =
  | { readonly ok: true; readonly value: number | null }
  | { readonly ok: false; readonly error: string };

/** Empty means no budget. Anything else must be a positive number of dollars. */
export function parseBudget(text: string): BudgetResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: true, value: null };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'Budget must be a positive number.' };
  }
  return { ok: true, value };
}

export interface LaunchForm {
  readonly prompt: string;
  readonly label: string;
  readonly cwd: string;
  readonly worktree: boolean;
  readonly maxBudgetUsd: number | null;
}

/** The label, or the first line of the prompt when no label is given. */
export function runLabel(form: LaunchForm): string {
  const label = form.label.trim();
  if (label !== '') {
    return label;
  }
  return truncate(form.prompt.trim().split('\n', 1).join(''), 40);
}

/** One spec per selected profile, or one with no profile when none is selected. */
export function buildSpecs(form: LaunchForm, selected: readonly LaunchProfile[]): LaunchSpec[] {
  const base = {
    prompt: form.prompt,
    cwd: form.cwd.trim(),
    worktree: form.worktree,
    maxBudgetUsd: form.maxBudgetUsd,
  };
  const label = runLabel(form);
  if (selected.length === 0) {
    return [{ ...base, profileId: null, label }];
  }
  return selected.map((profile) => ({
    ...base,
    profileId: profile.id,
    label: selected.length === 1 ? label : `${label} (${profile.name})`,
  }));
}

export function runCountLabel(count: number): string {
  return count === 1 ? '1 run' : `${count.toString()} runs`;
}

/** "Fast", "Fast and Deep", "Fast, Deep and Cheap". */
function listNames(names: readonly string[]): string {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names.slice(-1).join('')}`;
}

export interface LaunchPlan {
  readonly prompt: string;
  /** The folder the runs will work in, with an empty Folder field already filled in. */
  readonly folder: string;
  readonly worktree: boolean;
  readonly maxBudgetUsd: number | null;
  readonly profileNames: readonly string[];
}

/** "1 run with your usual settings", "1 run with Fast", "2 runs, one each for Fast and Deep". */
function describeRuns(names: readonly string[]): string {
  if (names.length === 0) {
    return '1 run with your usual settings';
  }
  if (names.length === 1) {
    return `1 run with ${listNames(names)}`;
  }
  return `${runCountLabel(names.length)}, one each for ${listNames(names)}`;
}

/** One sentence saying what Launch will do, or what it still needs. */
export function launchSummary(plan: LaunchPlan): string {
  if (plan.prompt.trim() === '') {
    return 'Write a prompt to launch.';
  }
  const several = plan.profileNames.length > 1;
  const each = several ? 'each ' : '';
  const place = plan.worktree ? `${each}in its own copy of ${plan.folder}` : `in ${plan.folder}`;
  const whom = several ? 'each one ' : '';
  const limit =
    plan.maxBudgetUsd === null
      ? 'with no spending limit'
      : `stopping ${whom}at ${formatUsd(plan.maxBudgetUsd)}`;
  return `Starts ${describeRuns(plan.profileNames)}, ${place}, ${limit}.`;
}

export const RUN_TONES: Readonly<Record<LaunchRun['state'], Tone>> = {
  queued: 'neutral',
  running: 'good',
  done: 'info',
  failed: 'critical',
  stopped: 'warning',
};

export function isActiveRun(run: LaunchRun): boolean {
  return run.state === 'queued' || run.state === 'running';
}
