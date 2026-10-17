// Launch profiles: named sets of model, effort, permission mode, env vars and
// extra CLI flags, kept in one JSON file in the extension's global storage.
// The mode and effort ids are checked against the profile's agent when it is
// saved. Listing does not check them, so a profile saved before that check
// (effort used to be free text) never makes the whole store unreadable.

import { z } from 'zod';

import type { AgentId, ModeOption } from '../../shared/agents.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { LaunchProfile } from '../../shared/model.js';

import { readOptional, writeFileAtomic } from './atomic-file.js';
import { errorMessage, parseJson } from './json.js';

const profileSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  agent: z.string().min(1).optional(),
  backend: z.string().min(1).optional(),
  model: z.string().min(1).nullable(),
  effort: z.string().min(1).nullable(),
  permissionMode: z.string().min(1).nullable(),
  env: z.record(z.string().min(1), z.string()),
  extraArgs: z.array(z.string()),
});

/** The permission modes and effort levels an agent's adapter offers. */
export interface AgentModes {
  readonly permission: readonly ModeOption[];
  readonly effort: readonly ModeOption[];
}

/** An agent's modes, or null when Overlord has no adapter for that agent. */
export type ModesLookup = (agent: AgentId) => AgentModes | null;

/** A lookup over adapters, or anything else with an id and modes. */
export function modesLookup(
  adapters: readonly { readonly id: AgentId; readonly modes: AgentModes }[],
): ModesLookup {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter.modes]));
  return (agent) => byId.get(agent) ?? null;
}

function checkMode(
  value: string | null,
  options: readonly ModeOption[],
  what: string,
  agent: AgentId,
): string | null {
  if (value === null || options.some((option) => option.id === value)) {
    return null;
  }
  const known = options.map((option) => option.id).join(', ');
  return options.length === 0
    ? `${agent} has no ${what} to set, so "${value}" cannot be used.`
    : `"${value}" is not a ${what} of ${agent}. Use one of ${known}.`;
}

/** Why the profile's modes do not fit its agent, or null when they do. */
function modeProblem(profile: LaunchProfile, modesFor: ModesLookup): string | null {
  const modes = modesFor(profile.agent);
  if (modes === null) {
    return `Overlord has no agent called ${profile.agent}.`;
  }
  return (
    checkMode(profile.permissionMode, modes.permission, 'permission mode', profile.agent) ??
    checkMode(profile.effort, modes.effort, 'effort level', profile.agent)
  );
}

const storeSchema = z.object({
  version: z.literal(1),
  profiles: z.array(profileSchema),
});

/** A profile saved before agents existed is a Claude Code one. */
function fromStored(stored: z.infer<typeof profileSchema>): LaunchProfile {
  const { agent, backend, ...rest } = stored;
  return { ...rest, agent: agent ?? CLAUDE_CODE, ...(backend === undefined ? {} : { backend }) };
}

/** Claude Code profiles are saved without an agent, so the file reads the same as before. */
function toStored(profile: LaunchProfile): Omit<LaunchProfile, 'agent'> & { agent?: string } {
  const { agent, backend, ...rest } = profile;
  return {
    ...rest,
    ...(agent === CLAUDE_CODE ? {} : { agent }),
    ...(backend === undefined ? {} : { backend }),
  };
}

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
    ? { profiles: parsed.data.profiles.map((stored) => fromStored(stored)), error: null }
    : { profiles: [], error: `${file} is not a profile store: ${parsed.error.message}` };
}

async function store(
  file: string,
  profiles: readonly LaunchProfile[],
): Promise<ProfileWriteResult> {
  try {
    const stored = profiles.map((item) => toStored(item));
    const content = `${JSON.stringify({ version: 1, profiles: stored }, null, 2)}\n`;
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
export async function saveProfile(
  file: string,
  profile: unknown,
  modesFor: ModesLookup,
): Promise<ProfileWriteResult> {
  const parsed = profileSchema.safeParse(profile);
  if (!parsed.success) {
    return { ok: false, error: `Invalid profile: ${parsed.error.message}` };
  }
  const next = fromStored(parsed.data);
  const problem = modeProblem(next, modesFor);
  if (problem !== null) {
    return { ok: false, error: `Invalid profile: ${problem}` };
  }
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
