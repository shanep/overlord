// The MCP registry search in the Connectors view: the last query, its
// results, and how the last install went. A search that finishes after a
// newer one started is dropped, so typing fast never shows stale results.

import { EMPTY_REGISTRY, type InstallNotice, type RegistryState } from '../../shared/connectors.js';
import { type RegistryEntry, searchRegistry } from '../connectors/registry.js';
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
  private readonly deps: RegistrySearchDeps;

  constructor(deps: RegistrySearchDeps) {
    this.deps = deps;
  }

  view(): RegistryState {
    return { ...this.state, results: this.entries.map((entry) => entry.server) };
  }

  /** A server from the last results, by its registry name. */
  entry(name: string): RegistryEntry | undefined {
    return this.entries.find((entry) => entry.server.name === name);
  }

  async search(query: string): Promise<void> {
    this.latest += 1;
    const ticket = this.latest;
    this.update({ query, searching: true, error: null });
    try {
      const page = await searchRegistry(this.deps.fetch, query);
      if (ticket === this.latest) {
        this.entries = page.entries;
        this.update({ searching: false, more: page.more });
      }
    } catch (error) {
      if (ticket === this.latest) {
        this.entries = [];
        this.update({
          searching: false,
          more: false,
          error: `Could not search the MCP registry: ${messageOf(error)}`,
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
