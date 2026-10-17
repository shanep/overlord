// The MCP registry search in the Connectors view: the last query, its
// results page by page, and how the last install went. A search or page that
// finishes after a newer search started is dropped, so typing fast never
// shows stale results. An empty query browses the whole registry.

import { EMPTY_REGISTRY, type InstallNotice, type RegistryState } from '../../shared/connectors.js';
import { searchRegistry } from '../connectors/registry-api.js';
import type { RegistryEntry } from '../connectors/registry.js';
import type { FetchFunction } from '../sync/github.js';

import { messageOf } from './errors.js';

export interface RegistrySearchDeps {
  readonly fetch: FetchFunction;
  readonly notify: () => void;
}

export class RegistrySearch {
  private state: Omit<RegistryState, 'results'> = EMPTY_REGISTRY;
  private entries: readonly RegistryEntry[] = [];
  private latest = 0;
  private next: string | null = null;
  private started = false;
  private readonly deps: RegistrySearchDeps;

  constructor(deps: RegistrySearchDeps) {
    this.deps = deps;
  }

  /** Loads the first page of the whole registry, once, so the view opens on something to browse. */
  start(): void {
    if (this.started || this.state.query !== null) {
      return;
    }
    this.started = true;
    void this.search('');
  }

  view(): RegistryState {
    return { ...this.state, results: this.entries.map((entry) => entry.server) };
  }

  /** A server from the last results, by its registry name. */
  entry(name: string): RegistryEntry | undefined {
    return this.entries.find((entry) => entry.server.name === name);
  }

  /** True when url is the repository of a server in the results, so it is safe to open. */
  knowsLink(url: string): boolean {
    return this.entries.some((entry) => entry.server.repository === url);
  }

  async search(query: string): Promise<void> {
    this.latest += 1;
    const ticket = this.latest;
    this.update({ query, searching: true, loadingMore: false, error: null });
    try {
      const page = await searchRegistry(this.deps.fetch, query);
      if (ticket === this.latest) {
        this.entries = page.entries;
        this.next = page.next;
        this.update({ searching: false, more: page.next !== null });
      }
    } catch (error) {
      if (ticket === this.latest) {
        this.entries = [];
        this.next = null;
        this.update({
          searching: false,
          more: false,
          error: `Could not search the MCP registry: ${messageOf(error)}`,
        });
      }
    }
  }

  /** Adds the next page to the results. */
  async more(): Promise<void> {
    const { query } = this.state;
    if (query === null || this.next === null || this.state.searching || this.state.loadingMore) {
      return;
    }
    const ticket = this.latest;
    this.update({ loadingMore: true, error: null });
    try {
      const page = await searchRegistry(this.deps.fetch, query, this.next);
      if (ticket === this.latest) {
        const known = new Set(this.entries.map((entry) => entry.server.name));
        this.entries = [
          ...this.entries,
          ...page.entries.filter((entry) => !known.has(entry.server.name)),
        ];
        this.next = page.next;
        this.update({ loadingMore: false, more: page.next !== null });
      }
    } catch (error) {
      if (ticket === this.latest) {
        this.update({
          loadingMore: false,
          error: `Could not load more from the MCP registry: ${messageOf(error)}`,
        });
      }
    }
  }

  /** Marks a server as installing, or clears it with how the install went. */
  installing(name: string | null, notice: InstallNotice | null = this.state.notice): void {
    this.update({ installing: name, notice });
  }

  private update(change: Partial<Omit<RegistryState, 'results'>>): void {
    this.state = { ...this.state, ...change };
    this.deps.notify();
  }
}
