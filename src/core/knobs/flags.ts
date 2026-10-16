// cspell:ignore statsig
// Read-only view of the server feature flags Claude Code caches in
// ~/.claude.json. The rest of that file holds the OAuth account, user and
// machine ids and more, so only allowlisted flag maps ever leave this module.
// There is deliberately no write function: the server rewrites this cache.

import { readFile } from 'node:fs/promises';

import type { ClaudePaths } from '../paths.js';

import { errorMessage, isArray, isNotFound, isPlainObject, parseJson } from './json.js';

/** Flag caches known to exist. Other keys need to match FLAG_KEY. */
const KNOWN_FLAG_KEYS: ReadonlySet<string> = new Set([
  'cachedGrowthBookFeatures',
  'cachedExperimentFeatures',
  'cachedExperimentData',
  'cachedStatsigGates',
  'cachedDynamicConfigs',
]);

const FLAG_KEY = /^cached[A-Z]\w*(?:Features|Gates|Configs|Flags)$/u;

/** Never returned, whatever the key looks like. */
const SENSITIVE_KEY = /oauth|token|account|email|user|machine|secret|password|credential|auth/iu;

export interface FeatureFlags {
  readonly flags: Readonly<Record<string, unknown>>;
  readonly error: string | null;
}

function isFlagMap(key: string, value: unknown): boolean {
  const allowedKey = KNOWN_FLAG_KEYS.has(key) || FLAG_KEY.test(key);
  return allowedKey && !SENSITIVE_KEY.test(key) && (isPlainObject(value) || isArray(value));
}

/** Pick only the cached flag maps out of parsed ~/.claude.json data. */
export function pickFeatureFlags(data: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(data)) {
    return {};
  }
  return Object.fromEntries(Object.entries(data).filter(([key, value]) => isFlagMap(key, value)));
}

export async function readFeatureFlags(
  paths: Pick<ClaudePaths, 'claudeJson'>,
): Promise<FeatureFlags> {
  let text: string;
  try {
    text = await readFile(paths.claudeJson, 'utf8');
  } catch (error) {
    return {
      flags: {},
      error: isNotFound(error) ? null : `Cannot read ${paths.claudeJson}: ${errorMessage(error)}`,
    };
  }
  const parsed = parseJson(text);
  return parsed.ok
    ? { flags: pickFeatureFlags(parsed.value), error: null }
    : { flags: {}, error: `Invalid JSON in ${paths.claudeJson}: ${parsed.error}` };
}
