// Skills and agent files across every agent in play. Some agents read the
// same folder (Copilot CLI reads a project's .claude/skills, and Copilot and
// Codex both read .agents/skills), so a skill is listed once with every agent
// that reads it. The config inventory already lists Claude Code's, so the
// scan here only adds what the other agents read and Claude does not.

import path from 'node:path';

import type { AgentId } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { LibraryItem } from '../../shared/catalog.js';
import type { ConfigItem, ConfigStatus } from '../../shared/model.js';
import type {
  AgentAdapter,
  LibraryFacet,
  LibraryFolder,
  LibraryPlace,
  LibraryScope,
} from '../agents/types.js';
import { parseFrontmatter, readText } from '../context/frontmatter.js';
import type { FileSystem } from '../context/fs.js';

import type { AuthoringKind } from './schema.js';

/** An agent that has skill or agent folders. */
export interface LibraryReader {
  readonly id: AgentId;
  /** Like Copilot CLI. */
  readonly name: string;
  /** Like Copilot. */
  readonly short: string;
  readonly library: LibraryFacet;
}

/**
 * The agents whose folders count: Claude Code always, as before there were
 * other agents, and any other agent once its binary is found and the
 * overlord.agents setting leaves it on.
 */
export function libraryReaders(
  adapters: readonly AgentAdapter[],
  inPlay: (id: AgentId) => boolean,
): LibraryReader[] {
  return adapters.flatMap((adapter): LibraryReader[] => {
    const library = adapter.config?.library;
    if (library === undefined || (adapter.id !== CLAUDE_CODE && !inPlay(adapter.id))) {
      return [];
    }
    return [{ id: adapter.id, name: adapter.name, short: adapter.short, library }];
  });
}

/** The folders of one kind an agent reads, highest precedence first. */
export function foldersOf(
  reader: LibraryReader,
  kind: AuthoringKind,
  place: LibraryPlace,
): readonly LibraryFolder[] {
  const facet = kind === 'skill' ? reader.library.skills : reader.library.agents;
  return facet?.folders(place) ?? [];
}

/** The agents that read a folder of this kind, in the order given. */
export function readersOf(
  readers: readonly LibraryReader[],
  kind: AuthoringKind,
  place: LibraryPlace,
  dir: string,
): LibraryReader[] {
  const wanted = path.resolve(dir);
  return readers.filter((reader) =>
    foldersOf(reader, kind, place).some((folder) => path.resolve(folder.dir) === wanted),
  );
}

/** One skill or agent file a scan found. */
export interface FoundItem {
  readonly kind: AuthoringKind;
  readonly name: string;
  /** The skill's folder, or the agent file. */
  readonly path: string;
  readonly scope: LibraryScope;
  /** Every agent in play that reads it. */
  readonly readers: readonly AgentId[];
}

async function skillsIn(fs: FileSystem, dir: string, prefix: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for (const entry of await fs.readdir(dir)) {
    const skillDir = path.join(dir, entry);
    const text = await fs.readFile(path.join(skillDir, 'SKILL.md'));
    if (text !== null) {
      const name = readText(parseFrontmatter(text).data['name']) ?? entry;
      out.push([`${prefix}${name}`, skillDir]);
    }
  }
  return out;
}

async function agentsIn(
  fs: FileSystem,
  reader: LibraryReader,
  dir: string,
  prefix: string,
): Promise<[string, string][]> {
  const facet = reader.library.agents;
  if (facet === undefined) {
    return [];
  }
  // An agent that writes .agent.md also reads plain .md files.
  const ending = facet.suffix.endsWith('.md') ? '.md' : facet.suffix;
  const out: [string, string][] = [];
  const names = await fs.readdir(dir);
  for (const entry of names.filter((name) => name.endsWith(ending))) {
    const file = path.join(dir, entry);
    const text = (await fs.kind(file)) === 'file' ? await fs.readFile(file) : null;
    if (text !== null) {
      out.push([`${prefix}${facet.nameOf(text, file)}`, file]);
    }
  }
  return out;
}

/**
 * Every skill or agent file in the folders of the given agents, once per
 * path, with every agent in play that reads its folder.
 */
export async function scanLibrary(input: {
  readonly fs: FileSystem;
  readonly kind: AuthoringKind;
  readonly place: LibraryPlace;
  /** Every agent in play, for who reads what. */
  readonly readers: readonly LibraryReader[];
  /** The agents whose folders to read. */
  readonly scan: readonly LibraryReader[];
}): Promise<FoundItem[]> {
  const { fs, kind, place, readers } = input;
  const byPath = new Map<string, FoundItem>();
  for (const reader of input.scan) {
    for (const folder of foldersOf(reader, kind, place)) {
      const entries =
        kind === 'skill'
          ? await skillsIn(fs, folder.dir, folder.prefix)
          : await agentsIn(fs, reader, folder.dir, folder.prefix);
      for (const [name, file] of entries) {
        if (!byPath.has(file)) {
          const who = readersOf(readers, kind, place, folder.dir).map((found) => found.id);
          byPath.set(file, { kind, name, path: file, scope: folder.scope, readers: who });
        }
      }
    }
  }
  return [...byPath.values()];
}

/** What the agents in play read, for the Skills and Agents views. */
export interface LibraryScan {
  readonly readers: readonly LibraryReader[];
  readonly place: LibraryPlace;
  /** What only the agents past Claude Code read, by kind. */
  readonly skill: readonly FoundItem[];
  readonly agent: readonly FoundItem[];
}

const STATUS: Readonly<Record<LibraryScope, ConfigStatus>> = {
  managed: 'managed',
  user: 'local-only',
  project: 'local-only',
  plugin: 'plugin',
};

function shorts(readers: readonly LibraryReader[], ids: readonly AgentId[]): string[] {
  return readers.filter((reader) => ids.includes(reader.id)).map((reader) => reader.short);
}

/**
 * The installed list for the Skills or Agents view. With Claude Code the only
 * agent in play it is the inventory as it was. Otherwise each item names the
 * agents that read it, and what only the other agents read is added.
 */
export function mergeLibrary(input: {
  readonly kind: AuthoringKind;
  /** Claude Code's, from the config inventory. */
  readonly installed: readonly ConfigItem[];
  /** What the other agents' folders hold. */
  readonly found: readonly FoundItem[];
  readonly readers: readonly LibraryReader[];
  readonly place: LibraryPlace;
}): LibraryItem[] {
  const { kind, installed, found, readers, place } = input;
  if (readers.length <= 1) {
    return [...installed];
  }
  const claude = readers.filter((reader) => reader.id === CLAUDE_CODE);
  const others = readers.filter((reader) => reader.id !== CLAUDE_CODE);
  const listed = new Set(installed.map((item) => item.path));
  const own: LibraryItem[] = installed.map((item) => {
    const also = item.path === null ? [] : readersOf(others, kind, place, path.dirname(item.path));
    return { ...item, agents: [...claude, ...also].map((reader) => reader.short) };
  });
  const extra = found
    .filter((item) => !listed.has(item.path) && !item.readers.includes(CLAUDE_CODE))
    .map((item): LibraryItem => ({
      id: `${kind}:${item.readers.join('+')}:${item.path}`,
      kind,
      name: item.name,
      scope: item.scope,
      path: item.path,
      realPath: null,
      status: STATUS[item.scope],
      repo: null,
      agents: shorts(readers, item.readers),
    }));
  return [...own, ...extra];
}
