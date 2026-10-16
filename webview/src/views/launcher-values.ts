// Pure helpers for the launcher: budget parsing and turning the form into
// one launch spec per selected profile (a matrix run).

import type { LaunchProfile, LaunchSpec } from '../../../src/shared/model.js';
import type { LaunchRun } from '../../../src/shared/protocol.js';
import { truncate } from '../format.js';
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
