// Turns the index into the view state: totals, the score, a row per day, a
// row per session, the most common kind and mean terms and the newest hits.

import type { ReputationHit, ReputationState, ReputationTally } from '../../shared/protocol.js';

import type { ReputationIndex } from './store.js';

export const TOP_TERMS = 10;
export const RECENT_HITS = 50;
/** A mean prompt outweighs a kind one, since the machines hold grudges. */
export const MEAN_WEIGHT = 2;
/** Pulls a short history toward the middle, so one thank you is not a verdict. */
export const SCORE_DAMPING = 10;

type SessionRow = ReputationState['bySession'][number];

/** Local calendar date, YYYY-MM-DD. */
export function dayOf(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/** -1 for only mean prompts, 1 for only kind ones, near 0 for few of either. */
export function reputationScore(tally: Pick<ReputationTally, 'kind' | 'mean'>): number {
  const mean = tally.mean * MEAN_WEIGHT;
  return (tally.kind - mean) / (tally.kind + mean + SCORE_DAMPING);
}

interface Tally {
  prompts: number;
  kind: number;
  mean: number;
  general: number;
}

function tallyFor(map: Map<string, Tally>, key: string): Tally {
  const found = map.get(key);
  if (found !== undefined) {
    return found;
  }
  const fresh: Tally = { prompts: 0, kind: 0, mean: 0, general: 0 };
  map.set(key, fresh);
  return fresh;
}

function hitsOf(index: ReputationIndex): ReputationHit[] {
  const hits: ReputationHit[] = [];
  for (const [id, prompt] of index.prompts) {
    const mean = index.hits.get(id);
    if (mean !== undefined) {
      const tone = mean.target === 'claude' ? 'mean' : 'general';
      hits.push({ id: `${id}:${tone}`, sessionId: prompt.sessionId, at: prompt.at, tone, ...mean });
    }
    const kind = index.kind.get(id);
    if (kind !== undefined) {
      hits.push({
        id: `${id}:kind`,
        sessionId: prompt.sessionId,
        at: prompt.at,
        tone: 'kind',
        ...kind,
      });
    }
  }
  return hits;
}

function topTerms(hits: readonly ReputationHit[]): ReputationState['topKind'] {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    for (const term of hit.terms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([term, count]) => ({ term, count }))
    .toSorted((left, right) => right.count - left.count || left.term.localeCompare(right.term))
    .slice(0, TOP_TERMS);
}

function sessionRows(
  sessions: ReadonlyMap<string, Tally>,
  titleOf: (sessionId: string) => string,
): SessionRow[] {
  return [...sessions]
    .filter(([, tally]) => tally.kind + tally.mean + tally.general > 0)
    .map(([sessionId, tally]) => ({
      sessionId,
      title: titleOf(sessionId),
      ...tally,
      score: reputationScore(tally),
    }))
    .toSorted(
      (left, right) =>
        left.score - right.score ||
        right.prompts - left.prompts ||
        left.sessionId.localeCompare(right.sessionId),
    );
}

export function summarize(
  index: ReputationIndex,
  titleOf: (sessionId: string) => string,
): ReputationState {
  const total: Tally = { prompts: 0, kind: 0, mean: 0, general: 0 };
  const days = new Map<string, Tally>();
  const sessions = new Map<string, Tally>();
  for (const [id, prompt] of index.prompts) {
    const target = index.hits.get(id)?.target;
    const kind = index.kind.has(id);
    for (const tally of [
      total,
      tallyFor(days, dayOf(prompt.at)),
      tallyFor(sessions, prompt.sessionId),
    ]) {
      tally.prompts += 1;
      tally.kind += kind ? 1 : 0;
      tally.mean += target === 'claude' ? 1 : 0;
      tally.general += target === 'general' ? 1 : 0;
    }
  }
  const hits = hitsOf(index);
  return {
    ...total,
    score: reputationScore(total),
    byDay: [...days]
      .map(([date, tally]) => ({ date, ...tally }))
      .toSorted((left, right) => left.date.localeCompare(right.date)),
    bySession: sessionRows(sessions, titleOf),
    topKind: topTerms(hits.filter((hit) => hit.tone === 'kind')),
    topMean: topTerms(hits.filter((hit) => hit.tone !== 'kind')),
    recent: hits.toSorted((left, right) => right.at - left.at).slice(0, RECENT_HITS),
    scannedAt: index.scannedAt,
  };
}
