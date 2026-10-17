// The catalog picks in the Tuning view: the skills and agents found for the
// kinds of work the sessions show, and how the last install went. The search
// runs again when the kinds of work change, once a day, or on Rescan, and a
// search that finishes after a newer one started is dropped.

import type { CatalogPicks } from '../../shared/tuning.js';
import type { FoundPick, PicksDeps, PickTopic } from '../catalog/picks.js';
import { findPicks, installKey } from '../catalog/picks.js';

import { messageOf } from './errors.js';

const PICKS_STALE_MS = 24 * 60 * 60_000;

export interface TuningPicksDeps extends PicksDeps {
  readonly notify: () => void;
  readonly clock: () => number;
}

type Shown = Omit<CatalogPicks, 'picks'>;

export class TuningPicks {
  private found: readonly FoundPick[] = [];
  private state: Shown = {
    topics: [],
    loading: false,
    error: null,
    installing: null,
    notice: null,
  };
  private key: string | null = null;
  private searchedAt = 0;
  private latest = 0;
  private readonly deps: TuningPicksDeps;

  constructor(deps: TuningPicksDeps) {
    this.deps = deps;
  }

  /** Searches when the topics changed, the last search is a day old, or `force` is set. */
  refresh(topics: readonly PickTopic[], installed: ReadonlySet<string>, force = false): void {
    const key = topics.map((topic) => topic.label).join('\n');
    const stale = this.deps.clock() - this.searchedAt >= PICKS_STALE_MS;
    if (!force && key === this.key && (!stale || this.state.loading)) {
      return;
    }
    this.key = key;
    this.searchedAt = this.deps.clock();
    void this.search(topics, installed);
  }

  private async search(
    topics: readonly PickTopic[],
    installed: ReadonlySet<string>,
  ): Promise<void> {
    this.latest += 1;
    const ticket = this.latest;
    this.update({ topics: topics.map((topic) => topic.label), loading: topics.length > 0 });
    if (topics.length === 0) {
      this.found = [];
      this.update({ error: null });
      return;
    }
    try {
      const result = await findPicks(this.deps, topics, installed);
      if (ticket === this.latest) {
        this.found = result.picks;
        this.update({
          loading: false,
          error:
            result.errors.length === 0
              ? null
              : `Some catalogs could not be searched. ${result.errors.join(' ')}`,
        });
      }
    } catch (error) {
      if (ticket === this.latest) {
        this.update({
          loading: false,
          error: `Could not search the catalogs: ${messageOf(error)}`,
        });
      }
    }
  }

  /** The picks, leaving out any installed since the search. */
  view(installed: ReadonlySet<string>): CatalogPicks {
    return {
      ...this.state,
      picks: this.found
        .map((found) => found.pick)
        .filter((pick) => !installed.has(installKey(pick.kind, pick.name))),
    };
  }

  /** True while a pick is being installed. */
  get busy(): boolean {
    return this.state.installing !== null;
  }

  pick(id: string): FoundPick | undefined {
    return this.found.find((found) => found.pick.id === id);
  }

  /** Marks a pick as installing, or clears it with how the install went. */
  installing(id: string | null, notice: Shown['notice'] = this.state.notice): void {
    this.update({ installing: id, notice });
  }

  private update(change: Partial<Shown>): void {
    this.state = { ...this.state, ...change };
    this.deps.notify();
  }
}
