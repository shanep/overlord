// Premade skills and agents that fit the work the sessions do. Skills come
// from a skills.sh search for each kind of work, most installed first.
// Agents come from the GitHub collections, matched on the words in their file
// name and group, so only the few that match are read for a description.

import type { CatalogPick } from '../../shared/tuning.js';
import type { FetchFunction } from '../sync/github.js';

import type { GitHubReader } from './github.js';
import type { FoundEntry } from './list.js';
import { fallbackName, readEntryFront, repoEntry, searchSkillsSh } from './list.js';
import type { RepoSource } from './sources.js';
import { entryGroup, repoSources } from './sources.js';

/** Skills and agents shown per kind of work, each. */
const PER_TOPIC = 2;

export interface PicksDeps {
  readonly reader: GitHubReader;
  readonly fetch: FetchFunction;
}

/** A kind of work to search for. */
export interface PickTopic {
  readonly label: string;
  /** What to search skills.sh for. */
  readonly query: string;
  /** Words in an agent's file name or group that mean it fits. */
  readonly words: readonly string[];
  /** What in the sessions points at the work. */
  readonly reason: string;
}

export interface FoundPick {
  readonly pick: CatalogPick;
  readonly found: FoundEntry;
}

export interface PicksResult {
  readonly picks: FoundPick[];
  /** One line per source that failed. */
  readonly errors: string[];
}

/** "skill:pdf", the key installed names and picks are compared by. */
export function installKey(kind: 'skill' | 'agent', name: string): string {
  return `${kind}:${name.toLowerCase()}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9+#]+/u));
}

interface AgentFile {
  readonly source: RepoSource;
  readonly path: string;
  readonly group: string;
  readonly name: string;
}

async function agentFiles(reader: GitHubReader, errors: string[]): Promise<AgentFile[]> {
  const all: AgentFile[] = [];
  for (const source of repoSources('agent')) {
    try {
      for (const file of await reader.files(source.id)) {
        const group = entryGroup(source, file.path);
        if (group !== null) {
          all.push({ source, path: file.path, group, name: fallbackName(file.path) });
        }
      }
    } catch (error) {
      errors.push(`${source.label}: ${messageOf(error)}`);
    }
  }
  return all;
}

/** Agents whose name fits first, then those whose group does, skipping names already taken. */
function matchAgents(
  files: readonly AgentFile[],
  topic: PickTopic,
  taken: ReadonlySet<string>,
): AgentFile[] {
  const ranked = files.flatMap((file) => {
    if (taken.has(installKey('agent', file.name))) {
      return [];
    }
    const byName = topic.words.some((word) => wordsOf(file.name).has(word));
    const byGroup = topic.words.some((word) => wordsOf(file.group).has(word));
    if (!byName && !byGroup) {
      return [];
    }
    return [{ file, rank: byName ? 0 : 1 }];
  });
  const chosen: AgentFile[] = [];
  const names = new Set<string>();
  for (const { file } of ranked.toSorted((left, right) => left.rank - right.rank)) {
    if (!names.has(file.name)) {
      names.add(file.name);
      chosen.push(file);
    }
    if (chosen.length === PER_TOPIC) {
      break;
    }
  }
  return chosen;
}

function pickOf(found: FoundEntry, kind: 'skill' | 'agent', topic: PickTopic): FoundPick {
  const { entry } = found;
  return {
    pick: {
      id: entry.id,
      kind,
      name: entry.name,
      description: entry.description,
      repo: entry.repo,
      url: entry.url,
      installs: entry.installs,
      topic: topic.label,
      reason: topic.reason,
    },
    found,
  };
}

async function skillPicks(
  fetchFunction: FetchFunction,
  topic: PickTopic,
  taken: Set<string>,
): Promise<FoundPick[]> {
  const found = await searchSkillsSh(fetchFunction, topic.query);
  const fresh = found
    .filter((item) => !taken.has(installKey('skill', item.entry.name)))
    .toSorted((left, right) => (right.entry.installs ?? 0) - (left.entry.installs ?? 0))
    .slice(0, PER_TOPIC);
  for (const item of fresh) {
    taken.add(installKey('skill', item.entry.name));
  }
  return fresh.map((item) => pickOf(item, 'skill', topic));
}

async function agentPicks(
  deps: PicksDeps,
  files: readonly AgentFile[],
  topic: PickTopic,
  taken: Set<string>,
): Promise<FoundPick[]> {
  const chosen = matchAgents(files, topic, taken);
  for (const file of chosen) {
    taken.add(installKey('agent', file.name));
  }
  const found = await Promise.all(
    chosen.map(async (file) =>
      repoEntry(
        file.source,
        file.path,
        file.group,
        await readEntryFront(deps.reader, file.source, file.path),
      ),
    ),
  );
  return found.map((item) => pickOf(item, 'agent', topic));
}

/**
 * Up to PER_TOPIC skills and PER_TOPIC agents per topic, leaving out what
 * `installed` holds (keys from installKey) and anything an earlier topic
 * already picked. A source that fails is reported and the rest still count.
 */
export async function findPicks(
  deps: PicksDeps,
  topics: readonly PickTopic[],
  installed: ReadonlySet<string>,
): Promise<PicksResult> {
  const errors: string[] = [];
  const taken = new Set(installed);
  const files = topics.length === 0 ? [] : await agentFiles(deps.reader, errors);
  const picks: FoundPick[] = [];
  let searchFailed = false;
  for (const topic of topics) {
    if (!searchFailed) {
      try {
        picks.push(...(await skillPicks(deps.fetch, topic, taken)));
      } catch (error) {
        // One failed search means skills.sh is down, so skip the rest.
        searchFailed = true;
        errors.push(`skills.sh: ${messageOf(error)}`);
      }
    }
    picks.push(...(await agentPicks(deps, files, topic, taken)));
  }
  return { picks, errors };
}
