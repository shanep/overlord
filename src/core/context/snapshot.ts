// Folds resolver output into a ContextSnapshot. Real token weights (from
// getContextUsage) win; estimates only fill the categories that are missing.

import type {
  ContextSnapshot,
  LoadedInstruction,
  SkillEntry,
  SkippedCandidate,
} from '../../shared/model.js';

type Weight = ContextSnapshot['weights'][number];

export const WEIGHT_LABELS = {
  systemPrompt: 'System prompt',
  memory: 'Memory files',
  autoMemory: 'Auto memory',
  skills: 'Skills',
  mcp: 'MCP instructions',
} satisfies Record<string, string>;

/** A rough count: about four characters per token. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export interface ResolvedParts {
  readonly expected: readonly LoadedInstruction[];
  readonly skipped: readonly SkippedCandidate[];
}

function plainLoaded(item: LoadedInstruction): LoadedInstruction {
  return {
    path: item.path,
    tier: item.tier,
    reason: item.reason,
    triggerPath: item.triggerPath,
    parentPath: item.parentPath,
    globs: item.globs,
    bytes: item.bytes,
    differsFromDisk: item.differsFromDisk,
    loadedAt: item.loadedAt,
  };
}

function plainSkill(skill: SkillEntry): SkillEntry {
  return {
    name: skill.name,
    source: skill.source,
    path: skill.path,
    listed: skill.listed,
    invoked: skill.invoked,
    descriptionChars: skill.descriptionChars,
  };
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

function estimates(snapshot: Omit<ContextSnapshot, 'weights'>): [string, number][] {
  const memory = snapshot.loaded.filter((item) => item.tier !== 'AutoMem');
  const auto = snapshot.loaded.filter((item) => item.tier === 'AutoMem');
  return [
    [WEIGHT_LABELS.systemPrompt, sum((snapshot.systemPrompt ?? []).map((part) => part.length))],
    [WEIGHT_LABELS.memory, sum(memory.map((item) => item.bytes))],
    [WEIGHT_LABELS.autoMemory, sum(auto.map((item) => item.bytes))],
    [
      WEIGHT_LABELS.skills,
      sum(snapshot.skills.filter((skill) => skill.listed).map((skill) => skill.descriptionChars)),
    ],
    [WEIGHT_LABELS.mcp, sum(snapshot.mcpServers.map((server) => server.instructions.length))],
  ];
}

/**
 * Fills `skipped` from the resolver, `loaded` and `skills` when the base has
 * none, and adds estimated weights for categories the base does not cover.
 */
export function mergeIntoSnapshot(
  base: ContextSnapshot,
  resolved: ResolvedParts,
  skills: readonly SkillEntry[] = [],
): ContextSnapshot {
  const merged: Omit<ContextSnapshot, 'weights'> = {
    ...base,
    loaded:
      base.loaded.length > 0 ? base.loaded : resolved.expected.map((item) => plainLoaded(item)),
    skipped: resolved.skipped,
    skills: base.skills.length > 0 ? base.skills : skills.map((skill) => plainSkill(skill)),
  };
  const known = new Set(base.weights.map((weight) => weight.label));
  const added: Weight[] = [];
  for (const [label, chars] of estimates(merged)) {
    if (!known.has(label) && chars > 0) {
      added.push({ label, tokens: estimateTokens(chars), estimated: true });
    }
  }
  return { ...merged, weights: [...base.weights, ...added] };
}
