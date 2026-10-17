// Turns a launch profile and spec into the settings one agent session needs.

import type { ModeOption } from '../../shared/agents.js';
import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';
import type { ConfigOverride, LaunchOverrides } from '../knobs/facet.js';
import { parseExtraArgs } from '../knobs/launch.js';

export interface SessionSettings {
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly extraArgs: Readonly<Record<string, string | null>>;
  /** Settings for this launch only, which Codex takes as -c key=value. */
  readonly config: readonly ConfigOverride[];
  readonly maxBudgetUsd: number | null;
}

/** The modes an agent takes, as its adapter lists them, and how its profiles reach a launch. */
interface AgentModes {
  readonly permission: readonly ModeOption[];
  readonly effort: readonly ModeOption[];
  /** The agent's knobs facet's launchOverrides. Without one, flags are read as they are. */
  readonly launch?: ((profile: LaunchProfile) => LaunchOverrides) | undefined;
}

/**
 * Profiles hold any agent's ids, so a run checks the id is one its agent
 * lists. An empty list means the agent only says at run time, so its
 * runtime checks instead.
 */
function checkMode(
  value: string | null,
  options: readonly ModeOption[],
  what: string,
): string | null {
  if (value === null || options.length === 0 || options.some((option) => option.id === value)) {
    return value;
  }
  throw new Error(`Unknown ${what} "${value}"`);
}

/** The SDK replaces the child environment with `env`, so start from the base environment. */
export function mergeEnv(
  base: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return { ...merged, ...overrides };
}

export function findProfile(
  spec: LaunchSpec,
  profiles: readonly LaunchProfile[],
): LaunchProfile | null {
  if (spec.profileId === null) {
    return null;
  }
  const profile = profiles.find((candidate) => candidate.id === spec.profileId);
  if (profile === undefined) {
    throw new Error(`Unknown launch profile "${spec.profileId}"`);
  }
  return profile;
}

/** The profile's flags and config overrides, through the agent's launch overrides when it has them. */
function profileArgs(
  profile: LaunchProfile | null,
  launch: AgentModes['launch'],
): Pick<SessionSettings, 'extraArgs' | 'config'> {
  if (profile === null) {
    return { extraArgs: {}, config: [] };
  }
  if (launch === undefined) {
    return { extraArgs: parseExtraArgs(profile.extraArgs), config: [] };
  }
  const { extraArgs, config } = launch(profile);
  return { extraArgs, config };
}

/**
 * The profile's model, effort and permission mode, with effort and mode
 * checked against the agent's lists. Launcher runs and terminal tabs both
 * start from these. Throws on an id the agent does not list.
 */
export function profileModes(
  profile: LaunchProfile | null,
  modes: Pick<AgentModes, 'permission' | 'effort'>,
): Pick<SessionSettings, 'model' | 'effort' | 'permissionMode'> {
  return {
    model: profile?.model ?? null,
    effort: checkMode(profile?.effort ?? null, modes.effort, 'effort level'),
    permissionMode: checkMode(profile?.permissionMode ?? null, modes.permission, 'permission mode'),
  };
}

export function sessionSettings(
  spec: LaunchSpec,
  profile: LaunchProfile | null,
  baseEnv: Readonly<Record<string, string | undefined>>,
  modes: AgentModes,
): SessionSettings {
  const args = profileArgs(profile, modes.launch);
  return {
    ...profileModes(profile, modes),
    env: mergeEnv(baseEnv, profile?.env ?? {}),
    ...args,
    maxBudgetUsd: spec.maxBudgetUsd,
  };
}
