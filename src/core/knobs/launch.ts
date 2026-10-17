// How a launch profile's settings reach a launch. Each agent's config facet
// picks the pieces it needs: Claude takes flags and env as they are, and an
// agent with a TOML config (Codex) can turn settings into `-c key=value`.

import type { LaunchProfile } from '../../shared/model.js';

import type { ConfigOverride, LaunchOverrides } from './facet.js';
import { formatTomlKey, formatTomlValue } from './toml-scan.js';

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

/** The profile's model, effort, mode, env and flags as they are, with no config overrides. */
export function toLaunchOptions(profile: LaunchProfile): LaunchOverrides {
  return {
    ...(profile.model === null ? {} : { model: profile.model }),
    ...(profile.effort === null ? {} : { effort: profile.effort }),
    ...(profile.permissionMode === null ? {} : { permissionMode: profile.permissionMode }),
    env: { ...profile.env },
    extraArgs: toExtraArgs(profile.extraArgs),
    config: [],
  };
}

/**
 * Config overrides as Codex-style argv: ["-c", "model=\"o3\"", ...]. Values
 * are TOML, so strings come out quoted.
 * @public
 */
export function configArgs(overrides: readonly ConfigOverride[], flag = '-c'): readonly string[] {
  return overrides.flatMap((item) => [
    flag,
    `${formatTomlKey(item.key)}=${'raw' in item ? item.raw : formatTomlValue(item.value)}`,
  ]);
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
