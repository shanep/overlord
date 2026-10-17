// Turns GitHub's Copilot CLI reference pages into KnobDefinition records:
// the settings tables in the configuration directory reference, and the
// command-line options, environment variables and OTel variables in the
// command reference. scripts/generate-catalog.mjs fetches the pages as
// Markdown and calls buildCopilotCatalog. Everything here is pure.
// cspell:words copilotsettingsjson githubcopilotsettingsjson

import type { KnobDefinition, KnobKind, KnobValueType } from '../../shared/model.js';

import { classifyArea } from './areas.js';
import { envTypeInfo, extractAllowedList, finalizeCatalog, parseEnvDefault } from './doc-parser.js';
import type { TypeInfo } from './doc-parser.js';
import {
  cell,
  cleanText,
  codeSpans,
  parseTables,
  stripQuotes,
  type MarkdownTable,
} from './markdown.js';

const DOCS = 'https://docs.github.com/en/copilot/reference/copilot-cli-reference';
export const COPILOT_CONFIG_DOCS = `${DOCS}/cli-config-dir-reference`;
export const COPILOT_COMMAND_DOCS = `${DOCS}/cli-command-reference`;

export interface CopilotPages {
  /** cli-config-dir-reference as Markdown: the settings.json tables. */
  readonly configDir: string;
  /** cli-command-reference as Markdown: options and environment variables. */
  readonly commandReference: string;
}

interface Draft {
  readonly key: string;
  readonly kind: KnobKind;
  readonly description: string;
  readonly typeInfo: TypeInfo;
  readonly defaultValue: string | null;
  readonly docUrl: string;
}

/** Copilot reads its settings at startup, so every knob applies at the next launch. */
function toKnob(draft: Draft): KnobDefinition {
  return {
    key: draft.key,
    kind: draft.kind,
    area: classifyArea({ key: draft.key, topic: '', description: draft.description }),
    valueType: draft.typeInfo.valueType,
    defaultValue: draft.defaultValue,
    allowed: draft.typeInfo.allowed,
    description: draft.description,
    docUrl: draft.docUrl,
    appliesAt: 'next-launch',
    managedOnly: false,
  };
}

const SIMPLE_TYPES: ReadonlyMap<string, KnobValueType> = new Map<string, KnobValueType>([
  ['boolean', 'boolean'],
  ['number', 'number'],
  ['string', 'string'],
  ['string[]', 'string[]'],
]);

/** A Type cell such as `boolean`, `string[]` or `"on"` | `"off"`. Anything else is JSON. */
export function copilotSettingType(typeCell: string): TypeInfo {
  const spans = codeSpans(typeCell);
  const [first] = spans;
  if (spans.length === 1 && first !== undefined) {
    const simple = SIMPLE_TYPES.get(first);
    if (simple !== undefined) {
      return { valueType: simple, allowed: [] };
    }
  }
  const quoted = spans.filter((span) => span.startsWith('"') && span.endsWith('"'));
  return quoted.length > 0 && quoted.length === spans.length
    ? { valueType: 'enum', allowed: quoted.map((span) => stripQuotes(span)) }
    : { valueType: 'json', allowed: [] };
}

/** A Default cell that opens with a code span gives that value. unset, varies and prose give null. */
export function copilotDefault(defaultCell: string): string | null {
  const trimmed = defaultCell.trim();
  if (!trimmed.startsWith('`')) {
    return null;
  }
  const [value] = codeSpans(trimmed);
  return value === undefined ? null : stripQuotes(value);
}

/** A dotted key path the settings writer can follow. `a["b"].c` is not one. */
function isPlainKey(key: string): boolean {
  return key.split('.').every((part) => /^[A-Za-z][\w-]*$/u.test(part));
}

function tablesUnder(markdown: string, heading: RegExp, first: string): readonly MarkdownTable[] {
  return parseTables(markdown).filter(
    (table) => heading.test(table.heading) && table.header[0] === first,
  );
}

function settingFromRow(row: readonly string[], anchor: string): KnobDefinition[] {
  const key = codeSpans(cell(row, 0))[0];
  if (key === undefined || !isPlainKey(key)) {
    return [];
  }
  // The user table is Key | Type | Default | Description, the repository table Key | Type | Merge | Description.
  const user = anchor.startsWith('#user');
  return [
    toKnob({
      key,
      kind: 'setting',
      description: cleanText(cell(row, 3)),
      typeInfo: copilotSettingType(cell(row, 1)),
      defaultValue: user ? copilotDefault(cell(row, 2)) : null,
      docUrl: `${COPILOT_CONFIG_DOCS}${anchor}`,
    }),
  ];
}

/** Settings from the user table, then repository-only keys from the repository table. */
function parseCopilotSettings(markdown: string): readonly KnobDefinition[] {
  const user = tablesUnder(markdown, /^User settings/u, 'Key').flatMap((table) =>
    table.rows.flatMap((row) => settingFromRow(row, '#user-settings-copilotsettingsjson')),
  );
  const repo = tablesUnder(markdown, /^Repository settings/u, 'Key').flatMap((table) =>
    table.rows.flatMap((row) =>
      settingFromRow(row, '#repository-settings-githubcopilotsettingsjson'),
    ),
  );
  return [...user, ...repo];
}

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/u;

function envFromRow(
  row: readonly string[],
  anchor: string,
  defaultColumn: boolean,
): KnobDefinition[] {
  const raw = cell(row, defaultColumn ? 2 : 1);
  const listed = defaultColumn ? copilotDefault(cell(row, 1)) : null;
  return codeSpans(cell(row, 0))
    .filter((key) => ENV_KEY.test(key))
    .map((key) =>
      toKnob({
        key,
        kind: 'env',
        description: cleanText(raw),
        typeInfo: envTypeInfo(key, raw),
        defaultValue: listed ?? parseEnvDefault(raw),
        docUrl: `${COPILOT_COMMAND_DOCS}${anchor}`,
      }),
    );
}

/** Env vars from the Environment variables table and the OTel one, which has a Default column. */
function parseCopilotEnv(markdown: string): readonly KnobDefinition[] {
  const plain = tablesUnder(markdown, /^Environment variables$/u, 'Variable').flatMap((table) =>
    table.rows.flatMap((row) => envFromRow(row, '#environment-variables', false)),
  );
  const otel = tablesUnder(markdown, /^OTel environment variables$/u, 'Variable').flatMap((table) =>
    table.rows.flatMap((row) => envFromRow(row, '#otel-environment-variables', true)),
  );
  return [...plain, ...otel];
}

/** Where a flag's value placeholder starts: "--add-dir=PATH", "-C DIRECTORY", "--resume[=VALUE]". */
const PLACEHOLDER_START = /[\s=[]/u;
const NUMBER_PLACEHOLDER = /^\[?[= ]?(?:COUNT|CREDITS|N|NUMBER)\]?$/u;

interface FlagSpan {
  readonly name: string;
  readonly placeholder: string;
}

function flagSpans(optionCell: string): readonly FlagSpan[] {
  return codeSpans(optionCell).flatMap((span) => {
    const text = span.trim();
    const start = text.search(PLACEHOLDER_START);
    const name = start === -1 ? text : text.slice(0, start);
    const placeholder = start === -1 ? '' : text.slice(start).trim();
    return name.startsWith('-') && name.length > 1 ? [{ name, placeholder }] : [];
  });
}

function flagType(spans: readonly FlagSpan[], purpose: string): TypeInfo {
  const placeholder = spans.find((span) => span.placeholder !== '')?.placeholder;
  if (placeholder === undefined) {
    return { valueType: 'boolean', allowed: [] };
  }
  if (NUMBER_PLACEHOLDER.test(placeholder)) {
    return { valueType: 'number', allowed: [] };
  }
  const allowed = extractAllowedList(purpose);
  return allowed.length > 0 ? { valueType: 'enum', allowed } : { valueType: 'string', allowed: [] };
}

function flagFromRow(row: readonly string[]): KnobDefinition[] {
  const spans = flagSpans(cell(row, 0));
  const long = spans.find((span) => span.name.startsWith('--')) ?? spans[0];
  if (long === undefined) {
    return [];
  }
  const aliases = spans.filter((span) => span !== long).map((span) => span.name);
  const raw = cell(row, 1);
  const aliasNote = aliases.length > 0 ? ` (alias: ${aliases.join(', ')})` : '';
  return [
    toKnob({
      key: long.name,
      kind: 'flag',
      description: `${cleanText(raw)}${aliasNote}`,
      typeInfo: flagType(spans, raw),
      defaultValue: null,
      docUrl: `${COPILOT_COMMAND_DOCS}#command-line-options`,
    }),
  ];
}

/** Flags from the Command-line options table. */
export function parseCopilotFlags(markdown: string): readonly KnobDefinition[] {
  return tablesUnder(markdown, /^Command-line options$/u, 'Option').flatMap((table) =>
    table.rows.flatMap((row) => flagFromRow(row)),
  );
}

export function buildCopilotCatalog(pages: CopilotPages): readonly KnobDefinition[] {
  return finalizeCatalog([
    ...parseCopilotSettings(pages.configDir),
    ...parseCopilotEnv(pages.commandReference),
    ...parseCopilotFlags(pages.commandReference),
  ]);
}
