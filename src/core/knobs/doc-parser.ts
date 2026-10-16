// Turns the Claude Code docs pages (settings reference, env vars, CLI
// reference) into KnobDefinition records. scripts/generate-catalog.mjs fetches
// the pages and calls buildCatalog; everything here is pure so it can be tested.
// The file name doc-parser.ts is fixed by PLAN.md, hence the one disable below.

// eslint-disable-next-line unicorn/prevent-abbreviations -- see the note above
import type { KnobDefinition, KnobKind, KnobValueType } from '../../shared/model.js';

import { appliesAtFor, classifyArea } from './areas.js';
import {
  capture,
  cell,
  cleanText,
  codeSpans,
  parseTables,
  slugify,
  stripQuotes,
  type MarkdownTable,
} from './markdown.js';

export const DOCS_BASE = 'https://code.claude.com/docs/en';

export interface ReferencePages {
  /** settings-reference.md, the full key reference. Null when the page does not exist. */
  readonly settingsReference: string | null;
  /** settings.md, used for keys only when the reference page is missing. */
  readonly settings: string;
  readonly envVariables: string;
  readonly cliReference: string;
}

export interface TypeInfo {
  readonly valueType: KnobValueType;
  readonly allowed: readonly string[];
}

interface KnobDraft {
  readonly key: string;
  readonly kind: KnobKind;
  readonly topic: string;
  readonly description: string;
  readonly typeInfo: TypeInfo;
  readonly defaultValue: string | null;
  readonly docUrl: string;
  readonly managedOnly: boolean;
}

function toKnob(draft: KnobDraft): KnobDefinition {
  return {
    key: draft.key,
    kind: draft.kind,
    area: classifyArea({
      key: draft.key,
      topic: draft.topic,
      description: draft.description,
      managedOnly: draft.managedOnly,
    }),
    valueType: draft.typeInfo.valueType,
    defaultValue: draft.defaultValue,
    allowed: draft.typeInfo.allowed,
    description: draft.description,
    docUrl: draft.docUrl,
    appliesAt: appliesAtFor(draft.kind, draft.key),
    managedOnly: draft.managedOnly,
  };
}

const PLAIN: TypeInfo = { valueType: 'string', allowed: [] };
const OPAQUE: TypeInfo = { valueType: 'json', allowed: [] };
const NESTED_BULLET_VALUE = /^\s+\*\s+`([^`]+)`/u;
const LIST_START = /(?:one of|accepts|options:|\()\s*`/iu;
const LIST_SEPARATORS: ReadonlySet<string> = new Set([', ', ' or ', ', or ']);

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** The `"quoted"` code spans of a fragment, without quotes. */
function quotedValues(text: string): readonly string[] {
  return unique(
    codeSpans(text)
      .filter((span) => /^".*"$/u.test(span))
      .map((span) => stripQuotes(span)),
  );
}

function nestedValues(nested: readonly string[]): readonly string[] {
  return unique(
    nested.flatMap((line) => {
      const value = capture(NESTED_BULLET_VALUE, line);
      return value === null ? [] : [stripQuotes(value)];
    }),
  );
}

function enumOrString(typeLine: string, nested: readonly string[]): TypeInfo {
  const lower = typeLine.toLowerCase();
  if (!lower.startsWith('string, one of') || lower.includes('such as')) {
    return PLAIN;
  }
  const inline = quotedValues(typeLine);
  const allowed = inline.length > 0 ? inline : nestedValues(nested);
  return allowed.length > 0 ? { valueType: 'enum', allowed } : PLAIN;
}

/** Read a settings key's value type from its "Type" bullet and the bullets nested under it. */
export function parseSettingType(typeLine: string, nested: readonly string[]): TypeInfo {
  const trimmed = typeLine.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('boolean')) {
    return { valueType: 'boolean', allowed: [] };
  }
  if (lower.startsWith('number') || lower.startsWith('integer')) {
    return { valueType: 'number', allowed: [] };
  }
  if (lower.startsWith('array')) {
    return lower.startsWith('array of objects') ? OPAQUE : { valueType: 'string[]', allowed: [] };
  }
  if (lower.startsWith('the string')) {
    return { valueType: 'enum', allowed: quotedValues(trimmed) };
  }
  return lower.startsWith('string') ? enumOrString(trimmed, nested) : OPAQUE;
}

/** A "Default" bullet that opens with a code span gives that value; "unset" and prose give null. */
export function parseDefault(text: string): string | null {
  const value = capture(/^`([^`]*)`/u, text.trim());
  return value === null ? null : stripQuotes(value);
}

/**
 * The values of a "(`a`, `b`, or `c`)", "one of `a`, `b`" or "Accepts `a` or
 * `b`" list: at least two code spans joined by commas or "or", and none of
 * them a "..." placeholder.
 */
export function extractAllowedList(text: string): readonly string[] {
  const start = LIST_START.exec(text);
  if (start === null) {
    return [];
  }
  const parts = text.slice(start.index + start[0].length - 1).split('`');
  const values: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 1) {
      values.push(stripQuotes(part));
    } else if (index > 0 && !LIST_SEPARATORS.has(part.replaceAll(/\s+/gu, ' '))) {
      break;
    }
  }
  const placeholder = values.some((value) => value.endsWith('...'));
  return values.length >= 2 && !placeholder ? values : [];
}

export interface SettingSection {
  readonly typeLine: string | null;
  readonly nested: readonly string[];
  readonly defaultText: string | null;
}

const SECTION_HEADING = /^### `([^`]+)`\s*$/u;
const TYPE_BULLET = /^\* \*\*Type\*\*:(.*)$/u;
const DEFAULT_BULLET = /^\* \*\*Default\*\*:(.*)$/u;
const NESTED_BULLET = /^\s+\* /u;

function readSection(lines: readonly string[]): SettingSection {
  let typeLine: string | null = null;
  let defaultText: string | null = null;
  const nested: string[] = [];
  let inType = false;
  for (const line of lines) {
    if (/^#{1,3} /u.test(line)) {
      break;
    }
    const typeMatch = capture(TYPE_BULLET, line);
    if (inType && NESTED_BULLET.test(line)) {
      nested.push(line);
    } else {
      inType = typeMatch !== null;
    }
    typeLine = typeMatch ?? typeLine;
    defaultText = capture(DEFAULT_BULLET, line) ?? defaultText;
  }
  return { typeLine, nested, defaultText };
}

/** Every "### `key`" section of the settings reference, by key. */
export function parseSettingSections(markdown: string): ReadonlyMap<string, SettingSection> {
  const lines = markdown.split('\n');
  const sections = new Map<string, SettingSection>();
  for (const [index, line] of lines.entries()) {
    const key = capture(SECTION_HEADING, line);
    if (key !== null) {
      sections.set(key, readSection(lines.slice(index + 1)));
    }
  }
  return sections;
}

function sectionType(section: SettingSection | undefined): TypeInfo {
  if (section === undefined || section.typeLine === null) {
    return OPAQUE;
  }
  return parseSettingType(section.typeLine, section.nested);
}

function settingFromRow(
  row: readonly string[],
  sections: ReadonlyMap<string, SettingSection>,
  page: string,
): KnobDefinition[] {
  const keyCell = cell(row, 0);
  const key = codeSpans(keyCell)[0];
  if (key === undefined) {
    return [];
  }
  const anchor = capture(/\]\((#[^)]+)\)/u, keyCell) ?? `#${slugify(key)}`;
  const section = sections.get(key);
  const knob = toKnob({
    key,
    kind: 'setting',
    topic: cell(row, 2),
    description: cleanText(cell(row, 1)),
    typeInfo: sectionType(section),
    defaultValue: parseDefault(section?.defaultText ?? ''),
    docUrl: `${DOCS_BASE}/${page}${anchor}`,
    managedOnly: cleanText(cell(row, 3)) === 'Managed',
  });
  return [knob];
}

function tablesWithHeader(markdown: string, first: string): readonly MarkdownTable[] {
  return parseTables(markdown).filter((table) => table.header[0] === first);
}

/** Settings keys from a "Key | Description | Topic | Scope" index table plus each key's section. */
export function parseSettingsPage(markdown: string, page: string): readonly KnobDefinition[] {
  const sections = parseSettingSections(markdown);
  return tablesWithHeader(markdown, 'Key')
    .filter((table) => table.header[1] === 'Description')
    .flatMap((table) => table.rows)
    .flatMap((row) => settingFromRow(row, sections, page));
}

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/u;
const ENV_DEFAULT_CODE = /\b(?:default:|defaults? (?:to|is))\s*`([^`]+)`/iu;
const ENV_DEFAULT_NUMBER = /\b(?:default:|defaults? (?:to|is))\s*(\d[\d_]*)\b/iu;
const ENV_NUMBER_KEY =
  /_(?:MS|TOKENS|LENGTH|COUNT|SIZE|LIMIT|RETRIES|SECONDS|PORT|WINDOW|PCT|TTL|CONCURRENCY|CHARS|BYTES|LINES)$/u;
const ENV_BOOLEAN_KEY = /(?:^|_)(?:DISABLE|ENABLE|SKIP|USE|FORCE)_/u;
const ENV_BOOLEAN_TEXT = /\bset (?:it )?to `?(?:1|true)\b/iu;

/** "Defaults to `x`", "default: 5000" and the like. */
export function parseEnvDefault(description: string): string | null {
  return capture(ENV_DEFAULT_CODE, description) ?? capture(ENV_DEFAULT_NUMBER, description);
}

export function envTypeInfo(key: string, description: string): TypeInfo {
  if (/^comma-separated/iu.test(description)) {
    return { valueType: 'string[]', allowed: [] };
  }
  if (ENV_BOOLEAN_KEY.test(key) || ENV_BOOLEAN_TEXT.test(description)) {
    return { valueType: 'boolean', allowed: [] };
  }
  const numericDefault = /^\d[\d_]*$/u.test(parseEnvDefault(description) ?? '');
  if (numericDefault || ENV_NUMBER_KEY.test(key) || /\bmilliseconds\b/iu.test(description)) {
    return { valueType: 'number', allowed: [] };
  }
  const allowed = extractAllowedList(description);
  return allowed.length > 0 ? { valueType: 'enum', allowed } : PLAIN;
}

function envFromRow(row: readonly string[]): KnobDefinition[] {
  const key = codeSpans(cell(row, 0))[0] ?? '';
  if (!ENV_KEY.test(key)) {
    return [];
  }
  const raw = cell(row, 1);
  const knob = toKnob({
    key,
    kind: 'env',
    topic: '',
    description: cleanText(raw),
    typeInfo: envTypeInfo(key, raw),
    defaultValue: parseEnvDefault(raw),
    docUrl: `${DOCS_BASE}/env-vars#variables`,
    managedOnly: false,
  });
  return [knob];
}

/** Env vars from the "Variable | Purpose" table. */
export function parseEnvVariablesPage(markdown: string): readonly KnobDefinition[] {
  return tablesWithHeader(markdown, 'Variable')
    .flatMap((table) => table.rows)
    .flatMap((row) => envFromRow(row));
}

const SHELL_TOKEN = /'[^']*'|"[^"]*"|\S+/gu;

function valueAfter(token: string, following: string | undefined): KnobValueType {
  const next = token.includes('=') ? token.slice(token.indexOf('=') + 1) : following;
  if (next === undefined || next.startsWith('-') || next === '"query"') {
    return 'boolean';
  }
  return /^[\d.]+$/u.test(next) ? 'number' : 'string';
}

/** Guess whether a flag takes a value from its header cell ("--debug-file <path>") or its example. */
export function flagValueType(
  headerCell: string,
  flags: readonly string[],
  example: string,
): KnobValueType {
  if (headerCell.includes('<')) {
    return 'string';
  }
  const command = codeSpans(example).join(' ');
  const tokens = [...command.matchAll(SHELL_TOKEN)].map((match) => match[0]);
  for (const [index, token] of tokens.entries()) {
    if (flags.includes(token.split('=', 1).join(''))) {
      return valueAfter(token, tokens[index + 1]);
    }
  }
  return 'string';
}

function flagFromRow(row: readonly string[], anchor: string): KnobDefinition[] {
  const headerCell = cell(row, 0);
  const flags = codeSpans(headerCell).map((header) => header.split(' ', 1).join(''));
  const [key, ...aliases] = flags;
  if (key?.startsWith('-') !== true) {
    return [];
  }
  const raw = cell(row, 1);
  const aliasNote = aliases.length > 0 ? ` (alias: ${aliases.join(', ')})` : '';
  const valueType = flagValueType(headerCell, flags, cell(row, 2));
  const allowed = valueType === 'boolean' ? [] : extractAllowedList(raw);
  const knob = toKnob({
    key,
    kind: 'flag',
    topic: '',
    description: `${cleanText(raw)}${aliasNote}`,
    typeInfo: { valueType: allowed.length > 0 ? 'enum' : valueType, allowed },
    defaultValue: null,
    docUrl: `${DOCS_BASE}/cli-reference#${anchor}`,
    managedOnly: false,
  });
  return [knob];
}

/** CLI flags from every "Flag | ..." table. */
export function parseCliPage(markdown: string): readonly KnobDefinition[] {
  return tablesWithHeader(markdown, 'Flag').flatMap((table) =>
    table.rows.flatMap((row) => flagFromRow(row, slugify(table.heading))),
  );
}

/** No kind name is a prefix of another, so this orders by kind, then key. */
function sortKey(knob: KnobDefinition): string {
  return `${knob.kind} ${knob.key}`;
}

/** Duplicates are gone before sorting, so two knobs never compare equal. */
function compareKnobs(left: KnobDefinition, right: KnobDefinition): number {
  return sortKey(left) < sortKey(right) ? -1 : 1;
}

/** Keep the first of each kind and key, then sort by kind, then key. */
export function finalizeCatalog(knobs: readonly KnobDefinition[]): readonly KnobDefinition[] {
  const seen = new Set<string>();
  const firsts = knobs.filter((knob) => {
    const id = sortKey(knob);
    const fresh = !seen.has(id);
    seen.add(id);
    return fresh;
  });
  return firsts.toSorted(compareKnobs);
}

export function buildCatalog(pages: ReferencePages): readonly KnobDefinition[] {
  const settings =
    pages.settingsReference === null
      ? parseSettingsPage(pages.settings, 'settings')
      : parseSettingsPage(pages.settingsReference, 'settings-reference');
  return finalizeCatalog([
    ...settings,
    ...parseEnvVariablesPage(pages.envVariables),
    ...parseCliPage(pages.cliReference),
  ]);
}
