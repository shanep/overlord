// Skill discovery: which SKILL.md files a session can see, and whether each
// one's description sits in the model's skill listing. The folders and the
// listing rules come from the session agent's skills facet.

import path from 'node:path';

import type { AgentId } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { SkillEntry } from '../../shared/model.js';
import { agents } from '../agents/index.js';
import type { LibraryFolder, LibraryScope, SkillsFacet } from '../agents/types.js';
import type { ClaudePaths } from '../paths.js';

import { parseFrontmatter, readFlag, readText } from './frontmatter.js';
import type { FileSystem } from './fs.js';
import { envOn, isInside, relativePosix } from './path-tools.js';
import { listSubdirectories } from './scan.js';
import { DEFAULT_SCAN_LIMITS, type ScanLimits } from './types.js';

/** Claude Code's listing cuts description plus when_to_use at this many characters. */
export { CLAUDE_LISTING_LIMIT as SKILL_DESCRIPTION_LIMIT } from '../agents/claude/library.js';

interface PluginRoot {
  readonly name: string;
  readonly root: string;
}

export interface SkillInput {
  readonly fs: FileSystem;
  readonly paths: ClaudePaths;
  /** The session's agent. Claude Code when left out. */
  readonly agentId?: AgentId;
  /** The agent's skills facet, looked up by agentId when left out. */
  readonly skills?: SkillsFacet;
  readonly cwd: string;
  /** Project skills load from cwd up to here. Null means cwd only. */
  readonly gitRoot: string | null;
  readonly addDirs: readonly string[];
  readonly touchedFiles: readonly string[];
  readonly plugins: readonly PluginRoot[];
  readonly bare: boolean;
  readonly safeMode: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Skill names the session invoked. */
  readonly invoked: readonly string[];
  readonly scan?: ScanLimits;
}

export interface DiscoveredSkill extends SkillEntry {
  readonly description: string;
  /** Why the skill is not in the listing, or null when it is. */
  readonly hiddenReason: string | null;
}

type Origin = 'managed' | 'user' | 'project' | 'add-dir' | 'nested' | 'claude-ai' | 'plugin';

interface Found {
  readonly name: string;
  readonly origin: Origin;
  readonly path: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly body: string;
  /** For nested skills, the directory whose files make it load. */
  readonly scopeDir: string | null;
}

const SOURCE: Readonly<Record<Origin, SkillEntry['source']>> = {
  managed: 'managed',
  user: 'user',
  project: 'project',
  'add-dir': 'project',
  nested: 'project',
  'claude-ai': 'claude-ai',
  plugin: 'plugin',
};

const ORIGIN: Readonly<Record<LibraryScope, Origin>> = {
  managed: 'managed',
  user: 'user',
  project: 'project',
  plugin: 'plugin',
};

/** Origins that share one namespace, highest precedence first. */
const RANKED: ReadonlySet<Origin> = new Set<Origin>(['managed', 'user', 'project', 'add-dir']);

function isReserved(skills: SkillsFacet, dirName: string, origin: Origin): boolean {
  // Plugin skills are namespaced, so the reserved names do not apply to them.
  if (origin === 'plugin') {
    return false;
  }
  const lower = dirName.toLowerCase();
  return skills.reserved.some((name) =>
    name.endsWith(':') ? lower.startsWith(name) : lower === name,
  );
}

interface Place {
  readonly origin: Origin;
  readonly scopeDir: string | null;
  readonly prefix: string;
}

async function readSkill(fs: FileSystem, skillDir: string, place: Place): Promise<Found | null> {
  const file = path.join(skillDir, 'SKILL.md');
  const text = (await fs.kind(file)) === 'file' ? await fs.readFile(file) : null;
  if (text === null) {
    return null;
  }
  const { data, body } = parseFrontmatter(text);
  const name = readText(data['name']) ?? path.basename(skillDir);
  return {
    name: `${place.prefix}${name}`,
    origin: place.origin,
    path: file,
    data,
    body,
    scopeDir: place.scopeDir,
  };
}

async function skillsIn(
  input: SkillInput,
  skills: SkillsFacet,
  dir: string,
  place: Place,
): Promise<Found[]> {
  const out: Found[] = [];
  for (const name of await input.fs.readdir(dir)) {
    const skill = isReserved(skills, name, place.origin)
      ? null
      : await readSkill(input.fs, path.join(dir, name), place);
    if (skill !== null) {
      out.push(skill);
    }
  }
  return out;
}

/** claude.ai skills sync into ~/.claude/skills/synced, one bucket dir per account. */
async function syncedSkills(input: SkillInput, skills: SkillsFacet, dir: string): Promise<Found[]> {
  const place: Place = { origin: 'claude-ai', scopeDir: null, prefix: '' };
  const out: Found[] = [];
  for (const name of await input.fs.readdir(dir)) {
    const child = path.join(dir, name);
    const direct = await readSkill(input.fs, child, place);
    out.push(...(direct === null ? await skillsIn(input, skills, child, place) : [direct]));
  }
  return out;
}

function folderPlace(folder: LibraryFolder): [string, Place] {
  return [folder.dir, { origin: ORIGIN[folder.scope], scopeDir: null, prefix: folder.prefix }];
}

/**
 * The agent's folders in order, with --add-dir folders and the folders below
 * cwd just before the plugin ones when the agent reads them.
 */
function skillDirs(
  input: SkillInput,
  skills: SkillsFacet,
  folders: readonly LibraryFolder[],
  subdirectories: readonly string[],
): [string, Place][] {
  const { nested } = skills;
  const extra: [string, Place][] =
    nested === null
      ? []
      : [
          ...input.addDirs.map((dir): [string, Place] => [
            path.join(dir, nested),
            { origin: 'add-dir', scopeDir: null, prefix: '' },
          ]),
          ...subdirectories.map((dir): [string, Place] => [
            path.join(dir, nested),
            { origin: 'nested', scopeDir: dir, prefix: '' },
          ]),
        ];
  const own = folders
    .filter((folder) => folder.scope !== 'plugin')
    .map((folder) => folderPlace(folder));
  const plugins = folders
    .filter((folder) => folder.scope === 'plugin')
    .map((folder) => folderPlace(folder));
  return [...own, ...extra, ...plugins];
}

async function findAll(input: SkillInput, skills: SkillsFacet): Promise<Found[]> {
  const scan = input.scan ?? DEFAULT_SCAN_LIMITS;
  const subdirectories =
    skills.nested === null
      ? []
      : await listSubdirectories(input.fs, input.cwd, input.touchedFiles, scan);
  const folders = skills.folders({
    home: input.paths.home,
    env: input.env,
    claude: input.paths,
    cwd: input.cwd,
    gitRoot: input.gitRoot,
    plugins: input.plugins,
  });
  const found: Found[] = [];
  for (const [dir, place] of skillDirs(input, skills, folders, subdirectories)) {
    found.push(...(await skillsIn(input, skills, dir, place)));
  }
  const user = folders.find((folder) => folder.scope === 'user');
  if (!skills.synced || user === undefined) {
    return found;
  }
  return [...found, ...(await syncedSkills(input, skills, path.join(user.dir, 'synced')))];
}

function describeSkill(skill: Found): string {
  const own = readText(skill.data['description']);
  if (own !== null) {
    return own;
  }
  return (
    skill.body
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  );
}

function modeReason(skill: Found, input: SkillInput, skills: SkillsFacet): string | null {
  if (input.safeMode) {
    return 'The session runs with --safe-mode, which loads no skills.';
  }
  if (input.bare && skill.origin !== 'add-dir') {
    return 'The session runs with --bare, which loads only skills from --add-dir directories.';
  }
  const off = skills.managedOffEnv;
  return skill.origin === 'managed' && off !== null && envOn(input.env[off])
    ? `${off} is set, so managed skills do not load.`
    : null;
}

function hiddenReason(
  skill: Found,
  input: SkillInput,
  skills: SkillsFacet,
  winner: Found | undefined,
): string | null {
  const mode = modeReason(skill, input, skills);
  if (mode !== null) {
    return mode;
  }
  if (winner !== undefined && winner !== skill) {
    return `A ${SOURCE[winner.origin]} skill with the same name takes precedence.`;
  }
  const scope = skill.scopeDir;
  if (scope !== null && !input.touchedFiles.some((file) => isInside(scope, path.resolve(file)))) {
    return `It loads once Claude works on a file under ${relativePosix(input.cwd, scope)}.`;
  }
  const manual = skills.manualOnly;
  return manual !== null && readFlag(skill.data[manual])
    ? `${manual} is set, so its description is not in context.`
    : null;
}

/** The facet for the input's agent, or null when the agent reads no skills. */
function skillsFor(input: SkillInput): SkillsFacet | null {
  return input.skills ?? agents.get(input.agentId ?? CLAUDE_CODE)?.config?.library?.skills ?? null;
}

/** Every skill the session could see, in precedence order, with its listing state. */
export async function discoverSkills(input: SkillInput): Promise<DiscoveredSkill[]> {
  const skills = skillsFor(input);
  if (skills === null) {
    return [];
  }
  const found = await findAll(input, skills);
  const ranked = (skill: Found): boolean => skills.ranked && RANKED.has(skill.origin);
  const winners = new Map<string, Found>();
  for (const skill of found) {
    // The first live skill of a name wins among managed, user and project.
    if (ranked(skill) && modeReason(skill, input, skills) === null && !winners.has(skill.name)) {
      winners.set(skill.name, skill);
    }
  }
  const limit = skills.listingLimit ?? Number.POSITIVE_INFINITY;
  return found.map((skill): DiscoveredSkill => {
    const description = describeSkill(skill);
    const extra = readText(skill.data['when_to_use']) ?? '';
    const hidden = hiddenReason(
      skill,
      input,
      skills,
      ranked(skill) ? winners.get(skill.name) : undefined,
    );
    return {
      name: skill.name,
      source: SOURCE[skill.origin],
      path: skill.path,
      listed: hidden === null,
      invoked: input.invoked.includes(skill.name),
      descriptionChars: Math.min(description.length + extra.length, limit),
      description,
      hiddenReason: hidden,
    };
  });
}
