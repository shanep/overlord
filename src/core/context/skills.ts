// Skill discovery: which SKILL.md files a session can see, and whether each
// one's description sits in the model's skill listing.

import path from 'node:path';

import type { SkillEntry } from '../../shared/model.js';
import type { ClaudePaths } from '../paths.js';

import { parseFrontmatter, readFlag, readText } from './frontmatter.js';
import type { FileSystem } from './fs.js';
import { envOn, isInside, joinUnder, relativePosix } from './path-tools.js';
import { listSubdirectories } from './scan.js';
import { DEFAULT_SCAN_LIMITS, type ScanLimits } from './types.js';

/** The listing cuts description plus when_to_use at this many characters. */
export const SKILL_DESCRIPTION_LIMIT = 1536;

interface PluginRoot {
  readonly name: string;
  readonly root: string;
}

export interface SkillInput {
  readonly fs: FileSystem;
  readonly paths: ClaudePaths;
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

/** Origins that share one namespace, highest precedence first. */
const RANKED: ReadonlySet<Origin> = new Set<Origin>(['managed', 'user', 'project', 'add-dir']);

function isReserved(dirName: string, origin: Origin): boolean {
  const lower = dirName.toLowerCase();
  // Plugin skills are namespaced, so the reserved names do not apply to them.
  if (origin === 'plugin') {
    return false;
  }
  return (
    lower === 'synced' || lower === 'anthropic-skills' || lower.startsWith('anthropic-skills:')
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

async function skillsIn(fs: FileSystem, dir: string, place: Place): Promise<Found[]> {
  const out: Found[] = [];
  for (const name of await fs.readdir(dir)) {
    const skill = isReserved(name, place.origin)
      ? null
      : await readSkill(fs, path.join(dir, name), place);
    if (skill !== null) {
      out.push(skill);
    }
  }
  return out;
}

/** claude.ai skills sync into ~/.claude/skills/synced, one bucket dir per account. */
async function syncedSkills(fs: FileSystem, dir: string): Promise<Found[]> {
  const place: Place = { origin: 'claude-ai', scopeDir: null, prefix: '' };
  const out: Found[] = [];
  for (const name of await fs.readdir(dir)) {
    const child = path.join(dir, name);
    const direct = await readSkill(fs, child, place);
    out.push(...(direct === null ? await skillsIn(fs, child, place) : [direct]));
  }
  return out;
}

function projectDirs(cwd: string, gitRoot: string | null): string[] {
  const out = [cwd];
  let dir = cwd;
  while (gitRoot !== null && dir !== gitRoot && isInside(gitRoot, dir)) {
    dir = path.dirname(dir);
    out.push(dir);
  }
  return out;
}

const PLAIN = { scopeDir: null, prefix: '' } satisfies Omit<Place, 'origin'>;

function local(dir: string): string {
  return path.join(dir, '.claude', 'skills');
}

function skillDirs(input: SkillInput, subdirectories: readonly string[]): [string, Place][] {
  return [
    [joinUnder(input.paths.managedDir, '.claude', 'skills'), { ...PLAIN, origin: 'managed' }],
    [input.paths.userSkillsDir, { ...PLAIN, origin: 'user' }],
    ...projectDirs(input.cwd, input.gitRoot).map((dir): [string, Place] => [
      local(dir),
      { ...PLAIN, origin: 'project' },
    ]),
    ...input.addDirs.map((dir): [string, Place] => [local(dir), { ...PLAIN, origin: 'add-dir' }]),
    ...subdirectories.map((dir): [string, Place] => [
      local(dir),
      { origin: 'nested', scopeDir: dir, prefix: '' },
    ]),
    ...input.plugins.map((plugin): [string, Place] => [
      path.join(plugin.root, 'skills'),
      { origin: 'plugin', scopeDir: null, prefix: `${plugin.name}:` },
    ]),
  ];
}

async function findAll(input: SkillInput): Promise<Found[]> {
  const scan = input.scan ?? DEFAULT_SCAN_LIMITS;
  const subdirectories = await listSubdirectories(input.fs, input.cwd, input.touchedFiles, scan);
  const found: Found[] = [];
  for (const [dir, place] of skillDirs(input, subdirectories)) {
    found.push(...(await skillsIn(input.fs, dir, place)));
  }
  const synced = await syncedSkills(input.fs, path.join(input.paths.userSkillsDir, 'synced'));
  return [...found, ...synced];
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

function modeReason(skill: Found, input: SkillInput): string | null {
  if (input.safeMode) {
    return 'The session runs with --safe-mode, which loads no skills.';
  }
  if (input.bare && skill.origin !== 'add-dir') {
    return 'The session runs with --bare, which loads only skills from --add-dir directories.';
  }
  return skill.origin === 'managed' && envOn(input.env['CLAUDE_CODE_DISABLE_POLICY_SKILLS'])
    ? 'CLAUDE_CODE_DISABLE_POLICY_SKILLS is set, so managed skills do not load.'
    : null;
}

function hiddenReason(skill: Found, input: SkillInput, winner: Found | undefined): string | null {
  const mode = modeReason(skill, input);
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
  return readFlag(skill.data['disable-model-invocation'])
    ? 'disable-model-invocation is set, so its description is not in context.'
    : null;
}

/** Every skill the session could see, in precedence order, with its listing state. */
export async function discoverSkills(input: SkillInput): Promise<DiscoveredSkill[]> {
  const found = await findAll(input);
  const winners = new Map<string, Found>();
  for (const skill of found) {
    // The first live skill of a name wins among managed, user and project.
    if (RANKED.has(skill.origin) && modeReason(skill, input) === null && !winners.has(skill.name)) {
      winners.set(skill.name, skill);
    }
  }
  return found.map((skill): DiscoveredSkill => {
    const description = describeSkill(skill);
    const extra = readText(skill.data['when_to_use']) ?? '';
    const hidden = hiddenReason(
      skill,
      input,
      RANKED.has(skill.origin) ? winners.get(skill.name) : undefined,
    );
    return {
      name: skill.name,
      source: SOURCE[skill.origin],
      path: skill.path,
      listed: hidden === null,
      invoked: input.invoked.includes(skill.name),
      descriptionChars: Math.min(description.length + extra.length, SKILL_DESCRIPTION_LIMIT),
      description,
      hiddenReason: hidden,
    };
  });
}
