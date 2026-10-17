// Turns a launch profile and spec into the settings one agent session needs.

import type { ModeOption } from '../../shared/agents.js';
import type { LaunchProfile, LaunchSpec } from '../../shared/model.js';

export interface SessionSettings {
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly extraArgs: Readonly<Record<string, string | null>>;
  readonly maxBudgetUsd: number | null;
}

/** The modes an agent takes, as its adapter lists them. */
interface AgentModes {
  readonly permission: readonly ModeOption[];
  readonly effort: readonly ModeOption[];
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

/**
 * Converts CLI-style arguments (`--flag`, `--key value`, `--key=value`) into
 * the SDK's extraArgs record, where null marks a flag with no value.
 */
export function parseExtraArgs(args: readonly string[]): Record<string, string | null> {
  const parsed: Record<string, string | null> = {};
  let key: string | null = null;
  for (const argument of args) {
    if (argument.startsWith('--')) {
      const body = argument.slice(2);
      const equals = body.indexOf('=');
      if (equals === -1) {
        parsed[body] = null;
        key = body;
      } else {
        parsed[body.slice(0, equals)] = body.slice(equals + 1);
        key = null;
      }
    } else if (key === null) {
      throw new Error(`Extra argument "${argument}" does not follow a --flag`);
    } else {
      parsed[key] = argument;
      key = null;
    }
  }
  return parsed;
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

export function sessionSettings(
  spec: LaunchSpec,
  profile: LaunchProfile | null,
  baseEnv: Readonly<Record<string, string | undefined>>,
  modes: AgentModes,
): SessionSettings {
  return {
    model: profile?.model ?? null,
    effort: checkMode(profile?.effort ?? null, modes.effort, 'effort level'),
    permissionMode: checkMode(profile?.permissionMode ?? null, modes.permission, 'permission mode'),
    env: mergeEnv(baseEnv, profile?.env ?? {}),
    extraArgs: parseExtraArgs(profile?.extraArgs ?? []),
    maxBudgetUsd: spec.maxBudgetUsd,
  };
}
