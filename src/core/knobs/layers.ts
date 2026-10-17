// Load every settings layer an agent reads, highest precedence first, as its
// config facet lists them. Missing files are empty layers; unreadable or
// malformed files are empty layers with an error, so one broken file never
// hides the others.

import { readFile } from 'node:fs/promises';

import { parse as parseToml } from 'smol-toml';

import type { SettingsLayer } from '../../shared/model.js';

import type { KnobsFacet, LayerSource, SettingsFormat, SettingsPlace } from './facet.js';
import {
  errorMessage,
  isArray,
  isNotFound,
  isPlainObject,
  parseJson,
  type JsonRecord,
  type ParsedJson,
} from './json.js';

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
  /** The agent's layers, file formats and env rules. */
  readonly knobs: KnobsFacet;
  readonly paths: SettingsPlace['paths'];
  /** The workspace folder, or null outside a project. */
  readonly projectDir: string | null;
  readonly cli?: CliSettings | null | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Env var names to pick from the process env, usually the catalog's env keys. */
  readonly envKeys?: ReadonlySet<string> | undefined;
}

/**
 * smol-toml gives tables with no prototype and dates as Date objects. Make
 * them plain objects and ISO strings, so TOML values look like JSON ones to
 * the rest of the knobs code and the webview.
 */
function plain(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (isArray(value)) {
    return value.map((item) => plain(item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}

function readToml(text: string): ParsedJson {
  try {
    const value = plain(parseToml(text));
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

const FORMAT_NAME: Readonly<Record<SettingsFormat, string>> = { json: 'JSON', toml: 'TOML' };

export async function readSettingsFile(
  layer: SettingsLayer,
  file: string,
  format: SettingsFormat = 'json',
): Promise<LayerData> {
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
  const name = FORMAT_NAME[format];
  const parsed = format === 'toml' ? readToml(text) : parseJson(text);
  if (!parsed.ok) {
    return { layer, file, values: {}, error: `Invalid ${name} in ${file}: ${parsed.error}` };
  }
  if (!isPlainObject(parsed.value)) {
    return { layer, file, values: {}, error: `${file} does not hold a ${name} object.` };
  }
  return { layer, file, values: parsed.value, error: null };
}

/** The process env subset, shaped as an `env` block so it flattens like a settings file. */
export function envLayer(
  env: Readonly<Record<string, string | undefined>>,
  envKeys: ReadonlySet<string>,
  prefix: RegExp | null,
  layer: SettingsLayer = 'env',
): LayerData {
  const picked = Object.entries(env).flatMap(([key, value]): [string, string][] =>
    value !== undefined && (envKeys.has(key) || prefix?.test(key) === true) ? [[key, value]] : [],
  );
  const values: JsonRecord = picked.length === 0 ? {} : { env: Object.fromEntries(picked) };
  return { layer, file: null, values, error: null };
}

async function loadLayer(
  source: LayerSource,
  options: LoadLayersOptions,
  place: SettingsPlace,
): Promise<LayerData | null> {
  switch (source.kind) {
    case 'file': {
      const file = source.file(place);
      return file === null ? null : readSettingsFile(source.layer, file, source.format);
    }
    case 'cli': {
      const cli = options.cli ?? null;
      return {
        layer: source.layer,
        file: cli?.file ?? null,
        values: cli?.values ?? {},
        error: null,
      };
    }
    case 'env': {
      const keys = options.envKeys ?? new Set<string>();
      return envLayer(options.env, keys, options.knobs.envPrefix, source.layer);
    }
  }
}

/** Every layer the facet lists, in its order. A layer that needs a project is left out when none is open. */
export async function loadLayers(options: LoadLayersOptions): Promise<readonly LayerData[]> {
  const place: SettingsPlace = {
    paths: options.paths,
    projectDir: options.projectDir,
    env: options.env,
  };
  const layers = await Promise.all(
    options.knobs.layers.map(async (source) => loadLayer(source, options, place)),
  );
  return layers.filter((layer) => layer !== null);
}
