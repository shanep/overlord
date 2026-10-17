// How a launch profile reaches a Codex launch. Codex takes any number of
// `-c key=value` overrides, and the extraArgs record keeps one value per flag,
// so a profile's `-c` and `--config` pairs come out of its args first and go
// in as config overrides, each passed on its own.

import type { LaunchProfile } from '../../../shared/model.js';
import type { ConfigOverride, LaunchOverrides } from '../../knobs/facet.js';
import { parseExtraArgs, toLaunchOptions } from '../../knobs/launch.js';
import { parseTomlKey } from '../../knobs/toml-edit.js';
import type { TabLaunch } from '../types.js';

import { splitMode } from './capabilities.js';

const CONFIG_FLAGS: ReadonlySet<string> = new Set(['-c', '--config']);
const INLINE = '--config=';

/**
 * One `key=value` as Codex reads it: a dotted TOML key, then the value as
 * TOML text, passed on as written. A quoted key may hold "=", so the split
 * is the first "=" that leaves a whole key before it.
 */
export function parseConfigPair(pair: string): ConfigOverride {
  for (let at = pair.indexOf('='); at !== -1; at = pair.indexOf('=', at + 1)) {
    const key = parseTomlKey(pair.slice(0, at).trim());
    if (key !== null) {
      return { key, raw: pair.slice(at + 1).trim() };
    }
  }
  throw new Error(`Config override "${pair}" is not key=value`);
}

/** The profile's args split into config overrides and the flags left over. */
export function splitConfigArgs(args: readonly string[]): {
  readonly config: readonly ConfigOverride[];
  readonly rest: readonly string[];
} {
  const config: ConfigOverride[] = [];
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (argument.startsWith(INLINE)) {
      config.push(parseConfigPair(argument.slice(INLINE.length)));
    } else if (CONFIG_FLAGS.has(argument)) {
      index += 1;
      const pair = args[index];
      if (pair === undefined) {
        throw new Error(`${argument} needs a key=value after it`);
      }
      config.push(parseConfigPair(pair));
    } else {
      rest.push(argument);
    }
  }
  return { config, rest };
}

/**
 * The profile's model, effort, mode and env as they are, its -c pairs as
 * config overrides, and its other flags read strictly, so a short flag or a
 * stray word is refused instead of dropped.
 */
export function codexLaunchOverrides(profile: LaunchProfile): LaunchOverrides {
  const { config, rest } = splitConfigArgs(profile.extraArgs);
  return { ...toLaunchOptions(profile), extraArgs: parseExtraArgs(rest), config };
}

/**
 * A profile's model, effort and mode as the settings a Codex tab takes with
 * -c, the same keys a Launcher run sets over app-server. -c goes before the
 * resume and fork subcommands too, where -m and -s would not.
 */
export function codexLaunchConfig(launch: TabLaunch): readonly ConfigOverride[] {
  const permission = launch.permissionMode === null ? null : splitMode(launch.permissionMode);
  return [
    ...(launch.model === null ? [] : [{ key: ['model'], value: launch.model }]),
    ...(launch.effort === null ? [] : [{ key: ['model_reasoning_effort'], value: launch.effort }]),
    ...(permission === null
      ? []
      : [
          { key: ['approval_policy'], value: permission.approvalPolicy },
          { key: ['sandbox_mode'], value: permission.sandbox },
        ]),
  ];
}
