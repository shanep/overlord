// Where new agents and skills go on disk, and the functions that write them.
// Claude Code's folders come from its scopes here. Another agent's folder is
// picked from its library facet and written with writeAuthoredFile. Writing
// never replaces an existing file unless the caller says so.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ClaudePaths } from '../paths.js';

import type { AuthoringKind } from './schema.js';

export type AuthoringScope = 'user' | 'project' | 'plugin';

export interface TargetDirs {
  readonly paths: Pick<ClaudePaths, 'userAgentsDir' | 'userSkillsDir'>;
  /** Project root. Files go under <projectDir>/.claude. */
  readonly projectDir?: string | undefined;
  /** Plugin root. Files go under <pluginDir>/agents and <pluginDir>/skills. */
  readonly pluginDir?: string | undefined;
}

export interface WriteRequest extends TargetDirs {
  readonly kind: AuthoringKind;
  readonly scope: AuthoringScope;
  readonly name: string;
  readonly text: string;
  readonly overwrite?: boolean | undefined;
}

export type WriteResult =
  | { readonly ok: true; readonly path: string; readonly replaced: boolean }
  | { readonly ok: false; readonly path: string; readonly reason: 'exists' };

/** The name becomes a file or directory name, so it must not escape its folder. */
export function assertSafeName(name: string): void {
  const unsafe =
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0');
  if (unsafe) {
    throw new Error(`"${name}" cannot be used as a file name.`);
  }
}

function required(dir: string | undefined, scope: AuthoringScope): string {
  if (dir === undefined || dir === '') {
    throw new Error(`Saving to ${scope} scope needs a ${scope} directory.`);
  }
  return dir;
}

function kindDirs(scope: AuthoringScope, dirs: TargetDirs): { agents: string; skills: string } {
  if (scope === 'user') {
    return { agents: dirs.paths.userAgentsDir, skills: dirs.paths.userSkillsDir };
  }
  const root =
    scope === 'project'
      ? path.join(required(dirs.projectDir, scope), '.claude')
      : required(dirs.pluginDir, scope);
  return { agents: path.join(root, 'agents'), skills: path.join(root, 'skills') };
}

export function targetPath(
  kind: AuthoringKind,
  scope: AuthoringScope,
  name: string,
  dirs: TargetDirs,
): string {
  assertSafeName(name);
  const base = kindDirs(scope, dirs);
  return kind === 'agent'
    ? path.join(base.agents, `${name}.md`)
    : path.join(base.skills, name, 'SKILL.md');
}

function isExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/** Writes one agent or skill file at a path the caller worked out. */
export async function writeAuthoredFile(
  file: string,
  text: string,
  overwrite: boolean,
): Promise<WriteResult> {
  assertSafeName(path.basename(file));
  await mkdir(path.dirname(file), { recursive: true });
  try {
    // "wx" fails if the file exists, so the check and the write cannot race.
    await writeFile(file, text, { flag: 'wx' });
    return { ok: true, path: file, replaced: false };
  } catch (error: unknown) {
    if (!isExistsError(error)) {
      throw error;
    }
  }
  if (!overwrite) {
    return { ok: false, path: file, reason: 'exists' };
  }
  await writeFile(file, text);
  return { ok: true, path: file, replaced: true };
}

export async function writeAuthored(request: WriteRequest): Promise<WriteResult> {
  const file = targetPath(request.kind, request.scope, request.name, request);
  return writeAuthoredFile(file, request.text, request.overwrite === true);
}
