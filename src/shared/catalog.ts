// What the Skills and Agents views show: the ones installed on this machine,
// and premade ones from public GitHub collections and skills.sh to install.

import type { InstallNotice } from './connectors.js';
import type { ConfigItem } from './model.js';

/** The Skills view lists skills and the Agents view lists agents. */
export type CatalogKind = 'skill' | 'agent';

/** A place premade skills or agents come from. */
export interface CatalogSource {
  /** owner/repo for a GitHub collection, or skills.sh. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly url: string;
  /** True when a query goes to the source's own search instead of filtering a list it loaded. */
  readonly search: boolean;
}

/** One premade skill or agent. */
export interface CatalogEntry {
  /** Unique within the view. */
  readonly id: string;
  readonly name: string;
  /** Empty when the source did not say, as in a skills.sh search. */
  readonly description: string;
  /** The GitHub repository it installs from, as owner/repo. */
  readonly repo: string;
  /** The category or plugin it sits under in its collection, or empty. */
  readonly group: string;
  /** How many times skills.sh saw it installed, or null when the source does not count. */
  readonly installs: number | null;
  /** Where to read it before installing. */
  readonly url: string;
}

export interface CatalogState {
  readonly sources: readonly CatalogSource[];
  /** The id of the source being shown. */
  readonly source: string;
  /** The query a search source's results are for, or null before the first search. */
  readonly query: string | null;
  readonly loading: boolean;
  readonly entries: readonly CatalogEntry[];
  readonly error: string | null;
  /** The id of the entry being installed right now. */
  readonly installing: string | null;
  readonly notice: InstallNotice | null;
}

export interface LibraryState {
  readonly kind: CatalogKind;
  /** The installed skills or agents, from the config inventory. */
  readonly installed: readonly ConfigItem[];
  readonly catalog: CatalogState;
}
