// Matrix runs: every prompt crossed with every profile, so one prompt can be
// compared across models, effort levels or permission modes.

import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';

export interface MatrixInput {
  readonly prompts: readonly string[];
  readonly profiles: readonly LaunchProfile[];
  readonly cwd: string;
  readonly worktree: boolean;
  readonly maxBudgetUsd?: number | null;
}

const SNIPPET_CHARS = 40;

/** The first line of a prompt, cut to a short label. */
export function promptSnippet(prompt: string): string {
  const firstLine = prompt.trim().split('\n', 1).join('').trim();
  return firstLine.length > SNIPPET_CHARS ? `${firstLine.slice(0, SNIPPET_CHARS)}...` : firstLine;
}

/** One spec per prompt and profile pair. With no profiles, one default run per prompt. */
export function expandMatrix(input: MatrixInput): LaunchSpec[] {
  const maxBudgetUsd = input.maxBudgetUsd ?? null;
  const specs: LaunchSpec[] = [];
  for (const [index, prompt] of input.prompts.entries()) {
    const base = `${String(index + 1)}. ${promptSnippet(prompt)}`;
    const columns: readonly (LaunchProfile | null)[] =
      input.profiles.length > 0 ? input.profiles : [null];
    for (const profile of columns) {
      specs.push({
        prompt,
        cwd: input.cwd,
        profileId: profile?.id ?? null,
        worktree: input.worktree,
        maxBudgetUsd,
        label: profile === null ? base : `${base} [${profile.name}]`,
      });
    }
  }
  return specs;
}
