// Turns the index into the view state: totals, a row per day, a row per
// session with hits, the most common terms and the newest hits.

import type { FrustrationHit, FrustrationState } from '../../shared/protocol.js';

import type { FrustrationIndex } from './store.js';

export const TOP_TERMS = 10;
export const RECENT_HITS = 50;

type DayRow = FrustrationState['byDay'][number];
type SessionRow = FrustrationState['bySession'][number];

/** Local calendar date, YYYY-MM-DD. */
export function dayOf(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

interface Tally {
  prompts: number;
  atClaude: number;
  general: number;
}

function tallyFor(map: Map<string, Tally>, key: string): Tally {
  const found = map.get(key);
  if (found !== undefined) {
    return found;
  }
  const fresh: Tally = { prompts: 0, atClaude: 0, general: 0 };
  map.set(key, fresh);
  return fresh;
}

function hitsOf(index: FrustrationIndex): FrustrationHit[] {
  const hits: FrustrationHit[] = [];
  for (const [id, hit] of index.hits) {
    const prompt = index.prompts.get(id);
    if (prompt !== undefined) {
      hits.push({ id, sessionId: prompt.sessionId, at: prompt.at, ...hit });
    }
  }
  return hits;
}

function topTerms(hits: readonly FrustrationHit[]): FrustrationState['topTerms'] {
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
    .map(([sessionId, tally]) => ({
      sessionId,
      title: titleOf(sessionId),
      prompts: tally.prompts,
      hits: tally.atClaude + tally.general,
    }))
    .filter((row) => row.hits > 0)
    .toSorted(
      (left, right) =>
        right.hits - left.hits ||
        right.prompts - left.prompts ||
        left.sessionId.localeCompare(right.sessionId),
    );
}

export function summarize(
  index: FrustrationIndex,
  titleOf: (sessionId: string) => string,
): FrustrationState {
  const days = new Map<string, Tally>();
  const sessions = new Map<string, Tally>();
  for (const [id, prompt] of index.prompts) {
    const hit = index.hits.get(id);
    for (const tally of [tallyFor(days, dayOf(prompt.at)), tallyFor(sessions, prompt.sessionId)]) {
      tally.prompts += 1;
      tally.atClaude += hit?.target === 'claude' ? 1 : 0;
      tally.general += hit?.target === 'general' ? 1 : 0;
    }
  }
  const byDay: DayRow[] = [...days]
    .map(([date, tally]) => ({ date, ...tally }))
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const hits = hitsOf(index);
  return {
    totalPrompts: index.prompts.size,
    atClaude: hits.filter((hit) => hit.target === 'claude').length,
    general: hits.filter((hit) => hit.target === 'general').length,
    byDay,
    bySession: sessionRows(sessions, titleOf),
    topTerms: topTerms(hits),
    recent: hits.toSorted((left, right) => right.at - left.at).slice(0, RECENT_HITS),
    scannedAt: index.scannedAt,
  };
}
