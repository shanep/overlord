// Lists the entries of a source: every skill or agent file in a GitHub
// collection with the name and description from its frontmatter, or the
// skills a skills.sh search finds.

import path from 'node:path';

import { z } from 'zod';

import type { CatalogEntry } from '../../shared/catalog.js';
import { parseFrontmatter } from '../authoring/frontmatter.js';
import type { FetchFunction } from '../sync/github.js';

import type { GitHubReader } from './github.js';
import { githubUrl, isRepo } from './github.js';
import type { RepoSource } from './sources.js';
import { entryGroup, SKILLS_SH } from './sources.js';

/** An entry and what installing it needs. */
export interface FoundEntry {
  readonly entry: CatalogEntry;
  /** The entry file: a skill's SKILL.md or an agent's .md. Null for a skills.sh result, found at install. */
  readonly path: string | null;
  /** The name skills.sh knows a skill by, to find its folder at install. */
  readonly skillId: string | null;
}

/** Frontmatter files fetched at once while listing a collection. */
const READ_AT_ONCE = 16;
const DESCRIPTION_LIMIT = 300;
const SEARCH_LIMIT = 50;
const SEARCH_TIMEOUT_MS = 15_000;

export const SKILLS_SH_SEARCH = 'https://skills.sh/api/search';

/** One line, cut at a word near the limit. */
export function shortDescription(text: string): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  if (flat.length <= DESCRIPTION_LIMIT) {
    return flat;
  }
  const cut = flat.slice(0, DESCRIPTION_LIMIT);
  const space = cut.lastIndexOf(' ');
  return `${(space > DESCRIPTION_LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The name an entry file gives itself, else its folder (a skill) or file name (an agent). */
export function fallbackName(filePath: string): string {
  const base = path.posix.basename(filePath);
  return base === 'SKILL.md'
    ? path.posix.basename(path.posix.dirname(filePath))
    : base.replace(/\.md$/u, '');
}

export interface Frontmatter {
  readonly name: string | null;
  readonly description: string;
}

const FRONTMATTER_BLOCK = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---/u;

const PLAIN_LINES = {
  name: /^name:(.*)$/mu,
  description: /^description:(.*)$/mu,
} as const;

/** One plain `key: value` line, quotes removed. */
function plainField(block: string, key: keyof typeof PLAIN_LINES): string | null {
  const line = PLAIN_LINES[key].exec(block)?.[1]?.trim() ?? '';
  const value = line.replace(/^(["'])(.*)\1$/u, '$2').trim();
  return value === '' ? null : value;
}

/**
 * The name and description. Many shared files put an unquoted ": " inside the
 * description, which is not valid YAML but which Claude Code loads anyway, so
 * the plain lines are read when the YAML will not parse.
 */
export function readFrontmatter(text: string): Frontmatter {
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) {
    const block = FRONTMATTER_BLOCK.exec(text)?.[1] ?? '';
    return {
      name: plainField(block, 'name'),
      description: shortDescription(plainField(block, 'description') ?? ''),
    };
  }
  const { name, description } = parsed.data;
  return {
    name: typeof name === 'string' && name.trim() !== '' ? name.trim() : null,
    description: typeof description === 'string' ? shortDescription(description) : '',
  };
}

async function mapAtMost<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await work(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** Every entry in the collection, sorted by group and name. An entry whose file will not load keeps its file name. */
export async function listRepo(reader: GitHubReader, source: RepoSource): Promise<FoundEntry[]> {
  const files = await reader.files(source.id);
  const matches = files.flatMap((file) => {
    const group = entryGroup(source, file.path);
    return group === null ? [] : [{ path: file.path, group }];
  });
  const found = await mapAtMost(matches, READ_AT_ONCE, async (match): Promise<FoundEntry> => {
    const front = await reader.text(source.id, match.path).then(readFrontmatter, () => ({
      name: null,
      description: '',
    }));
    const folder = source.kind === 'skill';
    return {
      entry: {
        id: `${source.id}:${match.path}`,
        name: front.name ?? fallbackName(match.path),
        description: front.description,
        repo: source.id,
        group: match.group,
        installs: null,
        url: githubUrl(source.id, folder ? path.posix.dirname(match.path) : match.path, folder),
      },
      path: match.path,
      skillId: null,
    };
  });
  return found.toSorted(
    (left, right) =>
      left.entry.group.localeCompare(right.entry.group) ||
      left.entry.name.localeCompare(right.entry.name),
  );
}

const searchSchema = z.object({
  skills: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      skillId: z.string(),
      name: z.string(),
      installs: z.number().optional(),
    }),
  ),
});

/** The skills skills.sh finds for the query, in its order. It needs two characters or more. */
export async function searchSkillsSh(
  fetchFunction: FetchFunction,
  query: string,
): Promise<FoundEntry[]> {
  const params = new URLSearchParams({ q: query.trim(), limit: String(SEARCH_LIMIT) });
  const response = await fetchFunction(`${SKILLS_SH_SEARCH}?${params.toString()}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'overlord' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`skills.sh answered ${String(response.status)}.`);
  }
  const parsed = searchSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('skills.sh sent results Overlord cannot read.');
  }
  return parsed.data.skills
    .filter((skill) => isRepo(skill.source))
    .map((skill) => ({
      entry: {
        id: `${SKILLS_SH}:${skill.id}`,
        name: skill.name,
        description: '',
        repo: skill.source,
        group: '',
        installs: skill.installs ?? null,
        url: `https://skills.sh/${skill.source}/${encodeURIComponent(skill.skillId)}`,
      },
      path: null,
      skillId: skill.skillId,
    }));
}
