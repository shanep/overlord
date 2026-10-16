// Secrets never go into the config repo. Files there hold ${secret:NAME}
// placeholders, the values live in a SecretStore (VS Code SecretStorage, so
// the OS keychain), and a scanner catches tokens before they are committed.

import { compareStrings, isArray, isRecord } from './json.js';

export interface SecretStore {
  readonly get: (name: string) => Promise<string | undefined>;
  readonly set: (name: string, value: string) => Promise<void>;
  readonly delete: (name: string) => Promise<void>;
}

/** An in-memory store, for tests and for runs with no keychain. */
export function createMemorySecretStore(
  initial: Readonly<Record<string, string>> = {},
): SecretStore {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    get: async (name: string): Promise<string | undefined> => {
      await Promise.resolve();
      return values.get(name);
    },
    set: async (name: string, value: string): Promise<void> => {
      await Promise.resolve();
      values.set(name, value);
    },
    delete: async (name: string): Promise<void> => {
      await Promise.resolve();
      values.delete(name);
    },
  };
}

const PLACEHOLDER = /\$\{secret:([\w.-]+)\}/gu;
const SECRET_NAME = /^[\w.-]+$/u;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function placeholderFor(name: string): string {
  if (!isSecretName(name)) {
    throw new Error(`Invalid secret name: ${name}`);
  }
  return `\${secret:${name}}`;
}

export function placeholdersInText(text: string): readonly string[] {
  const names: string[] = [];
  text.replaceAll(PLACEHOLDER, (whole: string, name: string) => {
    names.push(name);
    return whole;
  });
  return names;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, out);
    }
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      collectStrings(entry, out);
    }
  }
}

/** Every secret name referenced anywhere in a JSON value, sorted and unique. */
export function findPlaceholders(value: unknown): readonly string[] {
  const strings: string[] = [];
  collectStrings(value, strings);
  const names = new Set(strings.flatMap((text) => placeholdersInText(text)));
  return [...names].toSorted(compareStrings);
}

function mapStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === 'string') {
    return change(value);
  }
  if (isArray(value)) {
    return value.map((entry: unknown) => mapStrings(entry, change));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, change)]),
    );
  }
  return value;
}

export interface ResolveResult {
  readonly value: unknown;
  /** Names with no value in the store. Their placeholders are left as they were. */
  readonly missing: readonly string[];
}

interface Lookup {
  readonly known: ReadonlyMap<string, string>;
  readonly missing: readonly string[];
}

async function lookup(names: readonly string[], store: SecretStore): Promise<Lookup> {
  const known = new Map<string, string>();
  const missing: string[] = [];
  for (const name of names) {
    const stored = await store.get(name);
    if (typeof stored === 'string') {
      known.set(name, stored);
    } else {
      missing.push(name);
    }
  }
  return { known, missing };
}

function fill(text: string, known: ReadonlyMap<string, string>): string {
  return text.replaceAll(PLACEHOLDER, (whole: string, name: string) => known.get(name) ?? whole);
}

/** Fill in every ${secret:NAME} in a JSON value from the store. */
export async function resolveSecrets(value: unknown, store: SecretStore): Promise<ResolveResult> {
  const { known, missing } = await lookup(findPlaceholders(value), store);
  return { value: mapStrings(value, (text) => fill(text, known)), missing };
}

/** Fill in every ${secret:NAME} in one string. */
export async function resolveSecretsInText(
  text: string,
  store: SecretStore,
): Promise<{ readonly text: string; readonly missing: readonly string[] }> {
  const { known, missing } = await lookup(findPlaceholders(text), store);
  return { text: fill(text, known), missing };
}

export type SecretRule =
  | 'anthropic-key'
  | 'github-token'
  | 'github-pat'
  | 'aws-access-key'
  | 'slack-token'
  | 'slack-webhook'
  | 'private-key'
  | 'bearer-token';

export interface SecretFinding {
  readonly rule: SecretRule;
  /** Offset of the match in the scanned text. */
  readonly index: number;
  /** One based line number of the match. */
  readonly line: number;
  /** The first few characters only, so a finding can be shown without leaking it. */
  readonly preview: string;
}

interface Detector {
  readonly rule: SecretRule;
  readonly pattern: RegExp;
}

const DETECTORS: readonly Detector[] = [
  { rule: 'anthropic-key', pattern: /sk-ant-[\w-]{20,}/gu },
  { rule: 'github-token', pattern: /gh[oprsu]_[A-Za-z\d]{36,}/gu },
  { rule: 'github-pat', pattern: /github_pat_\w{22,}/gu },
  { rule: 'aws-access-key', pattern: /(?:AKIA|ASIA|ABIA|ACCA)[A-Z\d]{16}/gu },
  { rule: 'slack-token', pattern: /xox[abeoprs]-[A-Za-z\d-]{10,}/gu },
  { rule: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[\w/-]{20,}/gu },
  { rule: 'private-key', pattern: /-----BEGIN [A-Z\d ]{0,40}PRIVATE KEY-----/gu },
  { rule: 'bearer-token', pattern: /\bbearer\s+[\w~+/.-]{20,}/giu },
];

const PREVIEW_CHARS = 6;

export function redact(secret: string): string {
  return `${secret.slice(0, PREVIEW_CHARS)}...`;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) {
    line += 1;
  }
  return line;
}

/** Every token shaped string in `text`, in order of position. */
export function scanForSecrets(text: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const detector of DETECTORS) {
    for (const match of text.matchAll(detector.pattern)) {
      findings.push({
        rule: detector.rule,
        index: match.index,
        line: lineAt(text, match.index),
        preview: redact(match[0]),
      });
    }
  }
  return findings.toSorted((a, b) => a.index - b.index);
}

const SENSITIVE_KEY = /token|secret|passw(?:or)?d|api[-_]?key|auth|credential|private/iu;
const ENV_REFERENCE = /^\$\{[^}]+\}$/u;
const MIN_SECRET_LENGTH = 8;

/**
 * Whether an MCP env or header value should live in the keychain: it matches
 * a token pattern, or it sits under a sensitive key name and is a literal
 * (not a placeholder or a ${VAR} reference to the environment).
 */
export function looksLikeSecret(key: string, value: string): boolean {
  if (scanForSecrets(value).length > 0) {
    return true;
  }
  const reference = placeholdersInText(value).length > 0 || ENV_REFERENCE.test(value);
  return !reference && SENSITIVE_KEY.test(key) && value.length >= MIN_SECRET_LENGTH;
}
