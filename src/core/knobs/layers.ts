// Load every settings layer Claude Code reads, highest precedence first.
// Missing files are empty layers; unreadable or malformed files are empty
// layers with an error, so one broken file never hides the others.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { SettingsLayer } from '../../shared/model.js';
import type { ClaudePaths } from '../paths.js';

import { errorMessage, isNotFound, isPlainObject, parseJson, type JsonRecord } from './json.js';

export interface LayerData {
  readonly layer: SettingsLayer;
  /** The file the values came from, or null for the cli and env layers. */
  readonly file: string | null;
  readonly values: JsonRecord;
  readonly error: string | null;
}

interface CliSettings {
  /** The --settings file, or null when the JSON was passed inline. */
  readonly file: string | null;
  readonly values: JsonRecord;
}

export interface LoadLayersOptions {
  readonly paths: Pick<ClaudePaths, 'managedDir' | 'userSettings'>;
  /** The workspace folder, or null outside a project. */
  readonly projectDir: string | null;
  readonly cli?: CliSettings | null | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Env var names to pick from the process env, usually the catalog's env keys. */
  readonly envKeys?: ReadonlySet<string> | undefined;
}

/** Variables Overlord shows even when the catalog does not list them. */
const ENV_PREFIX = /^(?:ANTHROPIC|CLAUDE|OTEL)_/u;

export async function readSettingsFile(layer: SettingsLayer, file: string): Promise<LayerData> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return {
      layer,
      file,
      values: {},
      error: isNotFound(error) ? null : `Cannot read ${file}: ${errorMessage(error)}`,
    };
  }
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return { layer, file, values: {}, error: `Invalid JSON in ${file}: ${parsed.error}` };
  }
  if (!isPlainObject(parsed.value)) {
    return { layer, file, values: {}, error: `${file} does not hold a JSON object.` };
  }
  return { layer, file, values: parsed.value, error: null };
}

/** The process env subset, shaped as an `env` block so it flattens like a settings file. */
export function envLayer(
  env: Readonly<Record<string, string | undefined>>,
  envKeys: ReadonlySet<string>,
): LayerData {
  const picked = Object.entries(env).flatMap(([key, value]): [string, string][] =>
    value !== undefined && (envKeys.has(key) || ENV_PREFIX.test(key)) ? [[key, value]] : [],
  );
  const values: JsonRecord = picked.length === 0 ? {} : { env: Object.fromEntries(picked) };
  return { layer: 'env', file: null, values, error: null };
}

function cliLayer(cli: CliSettings | null): LayerData {
  return { layer: 'cli', file: cli?.file ?? null, values: cli?.values ?? {}, error: null };
}

async function projectLayers(projectDir: string | null): Promise<readonly LayerData[]> {
  if (projectDir === null) {
    return [];
  }
  const dir = path.join(projectDir, '.claude');
  return Promise.all([
    readSettingsFile('project-local', path.join(dir, 'settings.local.json')),
    readSettingsFile('project', path.join(dir, 'settings.json')),
  ]);
}

/** managed, cli, project-local, project, user, env: highest precedence first. */
export async function loadLayers(options: LoadLayersOptions): Promise<readonly LayerData[]> {
  const [managed, project, user] = await Promise.all([
    readSettingsFile('managed', path.join(options.paths.managedDir, 'managed-settings.json')),
    projectLayers(options.projectDir),
    readSettingsFile('user', options.paths.userSettings),
  ]);
  return [
    managed,
    cliLayer(options.cli ?? null),
    ...project,
    user,
    envLayer(options.env, options.envKeys ?? new Set()),
  ];
}
