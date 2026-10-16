// Launch profiles: named sets of model, effort, permission mode, env vars and
// extra CLI flags, kept in one JSON file in the extension's global storage.

import { z } from 'zod';

import type { LaunchProfile, PermissionMode } from '../../shared/model.js';

import { readOptional, writeFileAtomic } from './atomic-file.js';
import { errorMessage, parseJson } from './json.js';

const profileSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  model: z.string().min(1).nullable(),
  effort: z.string().min(1).nullable(),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions', 'manual'])
    .nullable(),
  env: z.record(z.string().min(1), z.string()),
  extraArgs: z.array(z.string()),
});

const storeSchema = z.object({
  version: z.literal(1),
  profiles: z.array(profileSchema),
});

export interface ProfileList {
  readonly profiles: readonly LaunchProfile[];
  /** Why the file could not be read; the list is empty then. */
  readonly error: string | null;
}

export type ProfileWriteResult =
  | { readonly ok: true; readonly profiles: readonly LaunchProfile[] }
  | { readonly ok: false; readonly error: string };

export async function listProfiles(file: string): Promise<ProfileList> {
  let text: string | null;
  try {
    text = await readOptional(file);
  } catch (error) {
    return { profiles: [], error: `Cannot read ${file}: ${errorMessage(error)}` };
  }
  if (text === null) {
    return { profiles: [], error: null };
  }
  const json = parseJson(text);
  if (!json.ok) {
    return { profiles: [], error: `Invalid JSON in ${file}: ${json.error}` };
  }
  const parsed = storeSchema.safeParse(json.value);
  return parsed.success
    ? { profiles: parsed.data.profiles, error: null }
    : { profiles: [], error: `${file} is not a profile store: ${parsed.error.message}` };
}

async function store(
  file: string,
  profiles: readonly LaunchProfile[],
): Promise<ProfileWriteResult> {
  try {
    const content = `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`;
    await writeFileAtomic({ target: file, content, backup: `${file}.bak` });
    return { ok: true, profiles };
  } catch (error) {
    return { ok: false, error: `Cannot write ${file}: ${errorMessage(error)}` };
  }
}

/**
 * Add a profile, or replace the one with the same id in place. A store file
 * that cannot be read is backed up to <file>.bak and started fresh.
 */
export async function saveProfile(file: string, profile: unknown): Promise<ProfileWriteResult> {
  const parsed = profileSchema.safeParse(profile);
  if (!parsed.success) {
    return { ok: false, error: `Invalid profile: ${parsed.error.message}` };
  }
  const next = parsed.data;
  const { profiles } = await listProfiles(file);
  const exists = profiles.some((item) => item.id === next.id);
  return store(
    file,
    exists ? profiles.map((item) => (item.id === next.id ? next : item)) : [...profiles, next],
  );
}

export async function deleteProfile(file: string, id: string): Promise<ProfileWriteResult> {
  const { profiles } = await listProfiles(file);
  return store(
    file,
    profiles.filter((item) => item.id !== id),
  );
}

/** What the Agent SDK query options need from a profile. Unset fields are left out. */
export interface LaunchOptions {
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: PermissionMode;
  readonly env: Readonly<Record<string, string>>;
  /** SDK extraArgs: flag name without dashes to value, null for a bare flag. */
  readonly extraArgs: Readonly<Record<string, string | null>>;
}

/** "--name" gives ["name", undefined], "--name=value" gives ["name", "value"], anything else null. */
function longFlag(token: string): readonly [string, string | undefined] | null {
  if (!token.startsWith('--') || token.length === 2) {
    return null;
  }
  const equals = token.indexOf('=');
  return equals === -1
    ? [token.slice(2), undefined]
    : [token.slice(2, equals), token.slice(equals + 1)];
}

/**
 * Turn ["--max-turns", "5", "--verbose", "--debug=api"] into
 * { "max-turns": "5", verbose: null, debug: "api" }. Tokens that are not
 * long flags, and the value after a short flag, are dropped.
 */
export function toExtraArgs(args: readonly string[]): Readonly<Record<string, string | null>> {
  const entries: [string, string | null][] = [];
  let pending: string | null = null;
  for (const token of args) {
    if (pending !== null) {
      // A value token is never a long flag, so it falls through harmlessly below.
      entries.push([pending, token.startsWith('-') ? null : token]);
      pending = null;
    }
    const flag = longFlag(token);
    if (flag === null) {
      continue;
    }
    const [name, value] = flag;
    if (value === undefined) {
      pending = name;
    } else {
      entries.push([name, value]);
    }
  }
  if (pending !== null) {
    entries.push([pending, null]);
  }
  return Object.fromEntries(entries);
}

export function toLaunchOptions(profile: LaunchProfile): LaunchOptions {
  return {
    ...(profile.model === null ? {} : { model: profile.model }),
    ...(profile.effort === null ? {} : { effort: profile.effort }),
    ...(profile.permissionMode === null ? {} : { permissionMode: profile.permissionMode }),
    env: { ...profile.env },
    extraArgs: toExtraArgs(profile.extraArgs),
  };
}
