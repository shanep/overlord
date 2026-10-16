// What must never reach the config repo: OAuth data, IDs, tokens, caches,
// transcripts, and every part of ~/.claude.json except the allowlisted keys.

import path from 'node:path';

import type { ClaudePaths } from '../paths.js';

import { isInside } from './files.js';
import { isArray, isRecord, type JsonRecord } from './json.js';

const DENIED_KEYS: ReadonlySet<string> = new Set([
  'oauthAccount',
  'userID',
  'machineID',
  'anonymousId',
  'primaryApiKey',
  'customApiKeyResponses',
]);

// "Any key with token in it", but not plural counters such as maxTokens or
// CLAUDE_CODE_MAX_OUTPUT_TOKENS, which are ordinary settings.
const TOKEN_KEY = /token(?!s)/iu;

export function isDeniedKey(key: string): boolean {
  return DENIED_KEYS.has(key) || TOKEN_KEY.test(key);
}

/** A copy of a JSON value with every denied key removed, at any depth. */
export function stripDeniedKeys(value: unknown): unknown {
  if (isArray(value)) {
    return value.map((entry: unknown) => stripDeniedKeys(entry));
  }
  if (isRecord(value)) {
    const kept = Object.entries(value).filter(([key]) => !isDeniedKey(key));
    return Object.fromEntries(kept.map(([key, entry]) => [key, stripDeniedKeys(entry)]));
  }
  return value;
}

/** The only top level keys of ~/.claude.json that Overlord reads. */
export const CLAUDE_JSON_ALLOWLIST: readonly string[] = ['mcpServers'];

/** The allowlisted part of ~/.claude.json. Nothing else is ever looked at. */
export function pickAllowedClaudeJson(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    return {};
  }
  const picked: Record<string, unknown> = {};
  for (const key of CLAUDE_JSON_ALLOWLIST) {
    const entry = value[key];
    if (isRecord(entry)) {
      picked[key] = entry;
    }
  }
  return picked;
}

// Top level entries of ~/.claude that are caches, logs, history or state.
const DENIED_CONFIG_ENTRIES: ReadonlySet<string> = new Set([
  '.credentials.json',
  'backups',
  'cache',
  'chrome',
  'daemon',
  'debug',
  'downloads',
  'feedback',
  'file-history',
  'history.jsonl',
  'ide',
  'jobs',
  'paste-cache',
  'session-env',
  'sessions',
  'shell-snapshots',
  'state',
  'statsig',
  'stats-cache.json',
  'telemetry',
  'todos',
]);

const KEY_FILE = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:pem|p12|key))$/u;

function deniedInConfigDir(target: string, configDir: string): boolean {
  const parts = path.relative(configDir, target).split(path.sep);
  const [first = ''] = parts;
  if (DENIED_CONFIG_ENTRIES.has(first)) {
    return true;
  }
  // Under projects/ only auto memory is synced. Transcripts stay local.
  return first === 'projects' && parts[2] !== 'memory';
}

/** Whether a file must never be copied into the config repo. */
export function isDeniedPath(target: string, paths: ClaudePaths): boolean {
  const resolved = path.resolve(target);
  const base = path.basename(resolved);
  if (base === '.credentials.json' || KEY_FILE.test(base)) {
    return true;
  }
  if (resolved === path.resolve(paths.claudeJson) || base.startsWith('.claude.json')) {
    return true;
  }
  return isInside(resolved, paths.configDir) && deniedInConfigDir(resolved, paths.configDir);
}
