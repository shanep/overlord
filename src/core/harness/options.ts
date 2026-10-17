// Turns a launch profile and spec into the settings one SDK session needs.

import { z } from 'zod';

import type { LaunchProfile, LaunchSpec, PermissionMode } from '../../shared/model.js';

import { parsePermissionMode } from './events.js';
import type { EffortLevel, SdkPermissionMode } from './sdk-types.js';

const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export interface SessionSettings {
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  readonly permissionMode: PermissionMode | null;
  readonly env: Readonly<Record<string, string>>;
  readonly extraArgs: Readonly<Record<string, string | null>>;
  readonly maxBudgetUsd: number | null;
}

export function toEffortLevel(value: string | null): EffortLevel | null {
  if (value === null) {
    return null;
  }
  const parsed = effortSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Unknown effort level "${value}"`);
  }
  return parsed.data;
}

/** Profiles hold any agent's mode id, so a Claude run checks it is one of Claude's. */
export function toPermissionMode(value: string | null): PermissionMode | null {
  if (value === null) {
    return null;
  }
  const mode = parsePermissionMode(value);
  if (mode === null) {
    throw new Error(`Unknown permission mode "${value}"`);
  }
  return mode;
}

/** Overlord's `manual` mode is what the SDK calls `default`: every tool asks. */
export function toSdkPermissionMode(mode: PermissionMode): SdkPermissionMode {
  return mode === 'manual' ? 'default' : mode;
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
): SessionSettings {
  return {
    model: profile?.model ?? null,
    effort: toEffortLevel(profile?.effort ?? null),
    permissionMode: toPermissionMode(profile?.permissionMode ?? null),
    env: mergeEnv(baseEnv, profile?.env ?? {}),
    extraArgs: parseExtraArgs(profile?.extraArgs ?? []),
    maxBudgetUsd: spec.maxBudgetUsd,
  };
}
