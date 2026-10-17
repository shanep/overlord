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

// Entries of an agent's own folder (~/.copilot, ~/.codex) that hold sign in
// data, sessions, history, logs, databases or caches. Copilot keeps its
// signed in accounts in config.json, so that file stays out too.
const DENIED_AGENT_ENTRIES: ReadonlySet<string> = new Set([
  '.credentials.json',
  'archived_sessions',
  'auth.json',
  'backups',
  'command-history-state.json',
  'config.json',
  'history',
  'history.jsonl',
  'hosts.json',
  'hosts.yml',
  'ide',
  'log',
  'logs',
  'pkg',
  'session-state',
  'sessions',
  'shell-snapshots',
  'tmp',
]);

// Any part of the path that names a token, a sign in, a database or a cache.
const DENIED_AGENT_PARTS: readonly RegExp[] = [
  /token|oauth|credential|secret|cache/iu,
  /^auth(?:[._-]|$)/iu,
  /\.(?:sqlite\d?|db|log)(?:-wal|-shm|-journal)?$/iu,
];

/**
 * Whether a path inside an agent's folder must never reach the config repo.
 * A path outside the folder is judged by the key file rule alone.
 */
function deniedPart(part: string): boolean {
  return DENIED_AGENT_PARTS.some((rule) => rule.test(part));
}

export function isDeniedAgentPath(target: string, agentDir: string): boolean {
  const resolved = path.resolve(target);
  if (KEY_FILE.test(path.basename(resolved))) {
    return true;
  }
  if (!isInside(resolved, agentDir)) {
    return false;
  }
  const parts = path.relative(path.resolve(agentDir), resolved).split(path.sep);
  const [first = ''] = parts;
  return DENIED_AGENT_ENTRIES.has(first) || parts.some((part) => deniedPart(part));
}

// Settings keys about who is signed in, where the agent keeps its state, or
// which folders are trusted here. A token limit or budget is an ordinary
// setting, so only other keys with token in them count.
const DENIED_SETTING_KEYS: readonly RegExp[] = [
  /token(?!s|_limit|_budget)|auth|log_?in|logged_?in|oauth|credential/iu,
  /secret|password|api_?key|sqlite/iu,
  /^(?:log_?dir|history|trusted_?folders)$/iu,
];

function deniedSettingKey(key: string): boolean {
  return DENIED_KEYS.has(key) || DENIED_SETTING_KEYS.some((rule) => rule.test(key));
}

/** Whether an agent settings key must never reach the config repo. Codex's hooks.state is its own bookkeeping. */
export function isDeniedSettingPath(keyPath: readonly string[]): boolean {
  const [first, second] = keyPath;
  if (first === 'hooks' && second === 'state') {
    return true;
  }
  return keyPath.some((key) => deniedSettingKey(key));
}
