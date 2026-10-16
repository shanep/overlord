// Client side history of total tokens per row, kept across state pushes,
// so each row can show a sparkline of recent activity like htop does.

import { useState } from 'react';

import type { FleetNode } from './fleet-rows.js';

export const HISTORY_CAP = 30;

export interface HistorySample {
  readonly key: string;
  readonly value: number;
}

export type RowHistory = ReadonlyMap<string, readonly number[]>;

/** Add one sample per row, keep the last `cap`, and drop rows that went away. */
export function appendHistory(
  history: RowHistory,
  samples: readonly HistorySample[],
  cap: number,
): Map<string, readonly number[]> {
  const next = new Map<string, readonly number[]>();
  for (const sample of samples) {
    const previous = history.get(sample.key) ?? [];
    next.set(sample.key, [...previous, sample.value].slice(-cap));
  }
  return next;
}

/** Growth between samples, never negative, which is the row's recent activity. */
export function deltas(values: readonly number[]): number[] {
  const out: number[] = [];
  let previous: number | null = null;
  for (const value of values) {
    if (previous !== null) {
      out.push(Math.max(0, value - previous));
    }
    previous = value;
  }
  return out;
}

/** One total token sample for every row in the tree. */
export function historySamples(nodes: readonly FleetNode[]): HistorySample[] {
  return nodes.flatMap((node) => [
    { key: node.row.key, value: node.row.tokensIn + node.row.tokensOut },
    ...historySamples(node.children),
  ]);
}

/**
 * History that grows by one sample each time `source` changes. Uses the
 * "adjust state while rendering" pattern, so there is no extra effect pass.
 */
export function useRowHistory(samples: readonly HistorySample[], source: unknown): RowHistory {
  const [seen, setSeen] = useState<unknown>(null);
  const [history, setHistory] = useState<RowHistory>(() => new Map());
  if (seen !== source) {
    setSeen(source);
    setHistory(appendHistory(history, samples, HISTORY_CAP));
  }
  return history;
}
