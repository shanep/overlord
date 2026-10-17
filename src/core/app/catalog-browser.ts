// The premade skills or agents in the Skills or Agents view: which source is
// shown, its entries, and how the last install went. A GitHub collection is
// listed once and kept, so switching back to it is instant. A load or search
// that finishes after a newer one started is dropped, so the view never shows
// the wrong source's entries.

import type { CatalogKind, CatalogSource, CatalogState } from '../../shared/catalog.js';
import type { InstallNotice } from '../../shared/connectors.js';
import type { GitHubReader } from '../catalog/github.js';
import type { FoundEntry } from '../catalog/list.js';
import { listRepo, searchSkillsSh } from '../catalog/list.js';
import { catalogSources, repoSources } from '../catalog/sources.js';
import type { FetchFunction } from '../sync/github.js';

import { messageOf } from './errors.js';

export interface CatalogBrowserDeps {
  readonly kind: CatalogKind;
  readonly reader: GitHubReader;
  readonly fetch: FetchFunction;
  readonly notify: () => void;
}

type Shown = Omit<CatalogState, 'sources' | 'entries'>;

const MIN_QUERY = 2;

export class CatalogBrowser {
  private readonly sources: readonly CatalogSource[];
  private state: Shown;
  private found: readonly FoundEntry[] = [];
  private readonly listed = new Map<string, readonly FoundEntry[]>();
  private latest = 0;
  private started = false;
  private readonly deps: CatalogBrowserDeps;

  constructor(deps: CatalogBrowserDeps) {
    this.deps = deps;
    this.sources = catalogSources(deps.kind);
    this.state = {
      source: this.sources[0]?.id ?? '',
      query: null,
      loading: false,
      error: null,
      installing: null,
      notice: null,
    };
  }

  /** Lists the first source, once, so the view opens on something to browse. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.browse(this.state.source);
  }

  view(): CatalogState {
    return {
      ...this.state,
      sources: this.sources,
      entries: this.found.map((found) => found.entry),
    };
  }

  /** An entry from the source being shown, by its id. */
  entry(id: string): FoundEntry | undefined {
    return this.found.find((found) => found.entry.id === id);
  }

  /** True when url is a source's page or an entry's, so it is safe to open. */
  knowsLink(url: string): boolean {
    return (
      this.sources.some((source) => source.url === url) ||
      this.found.some((found) => found.entry.url === url)
    );
  }

  /** Shows a source: lists a GitHub collection, or waits for a search on a search source. */
  async browse(sourceId: string): Promise<void> {
    const source = this.sources.find((candidate) => candidate.id === sourceId);
    if (source === undefined) {
      return;
    }
    this.started = true;
    this.latest += 1;
    const ticket = this.latest;
    this.found = [];
    const repo = repoSources(this.deps.kind).find((candidate) => candidate.id === sourceId);
    const known = this.listed.get(sourceId);
    if (repo === undefined || known !== undefined) {
      this.found = known ?? [];
      this.update({ source: sourceId, query: null, loading: false, error: null });
      return;
    }
    this.update({ source: sourceId, query: null, loading: true, error: null });
    try {
      const entries = await listRepo(this.deps.reader, repo);
      this.listed.set(sourceId, entries);
      if (ticket === this.latest) {
        this.found = entries;
        this.update({ loading: false });
      }
    } catch (error) {
      if (ticket === this.latest) {
        this.update({ loading: false, error: `Could not list ${repo.url}: ${messageOf(error)}` });
      }
    }
  }

  /** Searches the search source. */
  async search(query: string): Promise<void> {
    const source = this.sources.find((candidate) => candidate.search);
    if (source === undefined) {
      return;
    }
    const trimmed = query.trim();
    this.latest += 1;
    const ticket = this.latest;
    this.found = [];
    if (trimmed.length < MIN_QUERY) {
      this.update({
        source: source.id,
        query: trimmed,
        loading: false,
        error: `Type at least ${String(MIN_QUERY)} characters to search ${source.id}.`,
      });
      return;
    }
    this.update({ source: source.id, query: trimmed, loading: true, error: null });
    try {
      const entries = await searchSkillsSh(this.deps.fetch, trimmed);
      if (ticket === this.latest) {
        this.found = entries;
        this.update({ loading: false });
      }
    } catch (error) {
      if (ticket === this.latest) {
        this.update({
          loading: false,
          error: `Could not search ${source.id}: ${messageOf(error)}`,
        });
      }
    }
  }

  /** Marks an entry as installing, or clears it with how the install went. */
  installing(id: string | null, notice: InstallNotice | null = this.state.notice): void {
    this.update({ installing: id, notice });
  }

  private update(change: Partial<Shown>): void {
    this.state = { ...this.state, ...change };
    this.deps.notify();
  }
}
