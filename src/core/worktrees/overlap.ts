// Worktrees keep agents from editing each other's files while they work, but
// two agents changing the same file still conflict when the second one lands.
// Spotting that early lets the user steer one of them elsewhere.

import type { WorktreeOverlap } from '../../shared/protocol.js';

export interface OverlapInput {
  readonly id: string;
  readonly label: string;
  readonly repoRoot: string;
  readonly files: readonly string[];
}

/** Each worktree with the others in its repository that change some of the same files. */
export function withOverlaps<T extends OverlapInput>(
  items: readonly T[],
): (T & { readonly overlaps: readonly WorktreeOverlap[] })[] {
  return items.map((item) => {
    const mine = new Set(item.files);
    const overlaps = items.flatMap((other): WorktreeOverlap[] => {
      if (other.id === item.id || other.repoRoot !== item.repoRoot) {
        return [];
      }
      const shared = other.files.filter((file) => mine.has(file));
      return shared.length === 0 ? [] : [{ id: other.id, label: other.label, files: shared }];
    });
    return { ...item, overlaps };
  });
}
