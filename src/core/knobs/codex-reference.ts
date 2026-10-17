// Builds Codex CLI's knob catalog from its docs on learn.chatgpt.com:
//
// - config-reference.md lists every config.toml key in <ConfigTable> blocks of
//   { key, type, description } objects. Only the config.toml part counts. The
//   requirements.toml part after it is for administrators.
// - environment-variables.md lists the variables in markdown tables.
// - The developer commands page keeps its flag tables in the props of Astro
//   islands, so the global flags come from the page's HTML.
//
// Keys with a placeholder in them, like mcp_servers.<id>.command, are left
// out, since a knob needs a real key to set. scripts/generate-catalog.mjs
// fetches the pages and writes catalogs/codex.json.
// cspell:words astro

import type { KnobArea } from '../../shared/knob-areas.js';
import type { KnobDefinition, KnobKind, KnobValueType } from '../../shared/model.js';

import { classifyArea } from './areas.js';

export const CODEX_DOCS = 'https://learn.chatgpt.com/docs';
export const CONFIG_REFERENCE_URL = `${CODEX_DOCS}/config-file/config-reference`;
export const ENVIRONMENT_URL = `${CODEX_DOCS}/config-file/environment-variables`;
export const COMMANDS_URL = `${CODEX_DOCS}/developer-commands?surface=cli`;

/** The three pages, as the generator fetched them. */
export interface CodexReferencePages {
  /** config-reference.md */
  readonly configReference: string;
  /** environment-variables.md */
  readonly environment: string;
  /** The developer commands page as HTML. */
  readonly commandsHtml: string;
}

/** One row of a ConfigTable or a flag table. */
export interface ReferenceRow {
  readonly key: string;
  readonly type: string;
  readonly description: string;
  readonly defaultValue: string | null;
}

/**
 * Codex's own words for areas the shared keyword rules would get wrong, by
 * the key's first segment. The rest go through classifyArea.
 */
const PREFIX_AREAS: ReadonlyMap<string, KnobArea> = new Map<string, KnobArea>([
  ['approval_policy', 'permissions'],
  ['approvals_reviewer', 'permissions'],
  ['auto_review', 'permissions'],
  ['default_permissions', 'permissions'],
  ['permissions', 'permissions'],
  ['sandbox_mode', 'bash'],
  ['sandbox_workspace_write', 'bash'],
  ['shell_environment_policy', 'bash'],
  ['developer_instructions', 'context'],
  ['instructions', 'context'],
  ['model_instructions_file', 'context'],
  ['experimental_instructions_file', 'context'],
  ['project_doc_max_bytes', 'memory'],
  ['project_doc_fallback_filenames', 'memory'],
  ['memories', 'memory'],
  ['history', 'sessions'],
  ['profiles', 'sessions'],
  ['profile', 'sessions'],
  ['projects', 'sessions'],
  ['features', 'tools'],
  ['tools', 'tools'],
  ['web_search', 'tools'],
  ['notify', 'ui'],
  ['file_opener', 'ui'],
  ['hide_agent_reasoning', 'ui'],
  ['show_raw_agent_reasoning', 'ui'],
  ['analytics', 'telemetry'],
  ['otel', 'telemetry'],
  ['check_for_update_on_startup', 'updates'],
  ['forced_login_method', 'auth'],
  ['forced_chatgpt_workspace_id', 'auth'],
  ['cli_auth_credentials_store', 'auth'],
  ['CODEX_ACCESS_TOKEN', 'auth'],
  ['OPENAI_IDENTITY_TOKEN_FILE', 'auth'],
  ['CODEX_HOME', 'other'],
  ['apps', 'mcp'],
  ['computer_use', 'tools'],
  ['personality', 'model'],
  ['notice', 'ui'],
  ['log_dir', 'telemetry'],
  ['RUST_LOG', 'telemetry'],
  ['ask-for-approval', 'permissions'],
]);

/** A "..." or '...' literal after any whitespace at from. The docs never escape a quote inside one. */
function literalAt(text: string, from: number): { value: string; end: number } | null {
  let index = from;
  while (/\s/u.test(text[index] ?? '')) {
    index += 1;
  }
  const quote = text[index];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  const end = text.indexOf(quote, index + 1);
  return end === -1 ? null : { value: text.slice(index + 1, end), end: end + 1 };
}

/** The literal of the next `name:` field at or after from that starts a line's code. */
function fieldAfter(
  text: string,
  name: string,
  from: number,
): { value: string; end: number } | null {
  const label = `${name}:`;
  for (let at = text.indexOf(label, from); at !== -1; at = text.indexOf(label, at + 1)) {
    if (/\s/u.test(text[at - 1] ?? '')) {
      return literalAt(text, at + label.length);
    }
  }
  return null;
}

/** The { key, type, description } objects of every <ConfigTable> in a markdown page. */
export function parseConfigTables(markdown: string): readonly ReferenceRow[] {
  const rows: ReferenceRow[] = [];
  let key = fieldAfter(markdown, 'key', 0);
  while (key !== null) {
    const type = fieldAfter(markdown, 'type', key.end);
    const description = type === null ? null : fieldAfter(markdown, 'description', type.end);
    if (type === null || description === null) {
      break;
    }
    rows.push({
      key: key.value,
      type: type.value,
      description: description.value,
      defaultValue: null,
    });
    key = fieldAfter(markdown, 'key', description.end);
  }
  return rows;
}

/** The config.toml part of the config reference, before requirements.toml. */
export function configTomlSection(markdown: string): string {
  const start = markdown.indexOf('## `config.toml`');
  const end = markdown.indexOf('## `requirements.toml`');
  return markdown.slice(start === -1 ? 0 : start, end === -1 ? markdown.length : end);
}

function cells(line: string): readonly string[] {
  const inner = line.trim();
  const body = inner.slice(
    inner.startsWith('|') ? 1 : 0,
    inner.length - (inner.endsWith('|') ? 1 : 0),
  );
  return body.split('|').map((cell) => cell.trim());
}

function unquote(cell: string): string {
  return cell.replaceAll('`', '').trim();
}

const VARIABLE = /^[A-Z][A-Z\d_]*$/u;

/** One row of an env table, or null for the divider and anything not a variable. */
function envRow(header: readonly string[], row: readonly string[]): ReferenceRow | null {
  const variable = unquote(row[0] ?? '');
  if (!VARIABLE.test(variable)) {
    return null;
  }
  const column = (name: string): string => {
    const index = header.indexOf(name);
    return index === -1 ? '' : (row[index] ?? '');
  };
  const fallback = unquote(column('Default'));
  return {
    key: variable,
    type: 'string',
    description: column('Description'),
    defaultValue: fallback === '' ? null : fallback,
  };
}

/** Every row of every markdown table whose first column is Variable. */
export function parseEnvTables(markdown: string): readonly ReferenceRow[] {
  const rows: ReferenceRow[] = [];
  let header: readonly string[] | null = null;
  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('|')) {
      header = null;
    } else if (header === null) {
      header = cells(line);
    } else if (header[0] === 'Variable') {
      const row = envRow(header, cells(line));
      if (row !== null) {
        rows.push(row);
      }
    }
  }
  return rows;
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&quot;': '"',
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
};

function decodeEntities(text: string): string {
  return text.replaceAll(/&(?:quot|#39|lt|gt|amp);/gu, (entity) => ENTITIES[entity] ?? entity);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Astro serializes island props as [type, value] pairs: 0 for a plain value
 * or an object of pairs, 1 for an array of pairs.
 */
function revive(value: unknown): unknown {
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  }
  if (!isList(value) || value.length !== 2 || typeof value[0] !== 'number') {
    return value;
  }
  const [type, inner] = value;
  if (type === 1 && isList(inner)) {
    return inner.map((item) => revive(item));
  }
  return revive(inner);
}

function textField(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/** The options of every ConfigTable island on the page, one list per island. */
export function parseIslandTables(html: string): readonly (readonly ReferenceRow[])[] {
  const tables: ReferenceRow[][] = [];
  const island = /<astro-island[^>]*component-export="ConfigTable"[^>]*props="([^"]*)"/gu;
  for (const match of html.matchAll(island)) {
    let props: unknown;
    try {
      props = revive(JSON.parse(decodeEntities(match[1] ?? '')));
    } catch {
      continue;
    }
    const list = isRecord(props) ? props['options'] : undefined;
    const rows = isList(list) ? list.filter((row) => isRecord(row)) : [];
    tables.push(
      rows.flatMap((row) => {
        const key = textField(row, 'key');
        return key === null
          ? []
          : [
              {
                key,
                type: textField(row, 'type') ?? 'string',
                description: textField(row, 'description') ?? '',
                defaultValue: textField(row, 'defaultValue'),
              },
            ];
      }),
    );
  }
  return tables;
}

/** The global flags: the first flag table on the page, with each flag's long name. */
export function parseGlobalFlags(html: string): readonly ReferenceRow[] {
  const table = parseIslandTables(html).find((rows) =>
    rows.some((row) => row.key.startsWith('--')),
  );
  return (table ?? []).flatMap((row) => {
    const long = row.key
      .split(',')
      .map((part) => part.trim())
      .find((part) => part.startsWith('--'));
    return long === undefined ? [] : [{ ...row, key: long }];
  });
}

const SIMPLE_WORD = /^[\w.-]+$/u;

/** The value type and allowed values a Codex type line describes. */
export function codexType(type: string): {
  readonly valueType: KnobValueType;
  readonly allowed: readonly string[];
} {
  const paren = type.indexOf('(');
  const plain = (paren === -1 ? type : type.slice(0, paren)).trim();
  if (plain === 'boolean') {
    return { valueType: 'boolean', allowed: [] };
  }
  if (plain === 'number' || plain === 'integer') {
    return { valueType: 'number', allowed: [] };
  }
  if (plain === 'string' || plain === 'path') {
    return { valueType: 'string', allowed: [] };
  }
  if (plain === 'array<string>') {
    return { valueType: 'string[]', allowed: [] };
  }
  const choices = plain.split('|').map((choice) => choice.trim());
  if (choices.length > 1 && choices.every((choice) => SIMPLE_WORD.test(choice))) {
    return { valueType: 'enum', allowed: choices };
  }
  return { valueType: 'json', allowed: [] };
}

/** The default a description names, as in "(default: `x`)" or "Defaults to `x`". */
export function codexDefault(description: string): string | null {
  const match = /\(default:\s*`([^`]+)`|[Dd]efaults? to `([^`]+)`/u.exec(description);
  const found = match?.[1] ?? match?.[2] ?? null;
  return found === null ? null : found.replace(/^"(.*)"$/u, '$1');
}

const DASHES: readonly string[] = [String.fromCodePoint(0x20_13), String.fromCodePoint(0x20_14)];

/** Markdown links [text](url) reduced to their text. */
function unlink(markdown: string): string {
  let kept = '';
  let rest = markdown;
  let open = rest.indexOf('[');
  while (open !== -1) {
    const middle = rest.indexOf('](', open);
    const end = middle === -1 ? -1 : rest.indexOf(')', middle);
    if (end === -1) {
      break;
    }
    kept += rest.slice(0, open) + rest.slice(open + 1, middle);
    rest = rest.slice(end + 1);
    open = rest.indexOf('[');
  }
  return kept + rest;
}

/** Docs text with Markdown links reduced to their text, one space between words, and no dashes. */
function plainText(description: string): string {
  let undashed = unlink(description);
  for (const dash of DASHES) {
    undashed = undashed.replaceAll(dash, ',');
  }
  return undashed
    .split(/\s/u)
    .filter((word) => word !== '')
    .join(' ')
    .replaceAll(' ,', ',');
}

function areaOf(key: string, description: string): KnobArea {
  const first = key.split('.', 1)[0] ?? key;
  return (
    PREFIX_AREAS.get(first) ??
    PREFIX_AREAS.get(key) ??
    classifyArea({ key, topic: '', description })
  );
}

function knob(option: ReferenceRow, kind: KnobKind, page: string): KnobDefinition {
  const description = plainText(option.description);
  const typed =
    kind === 'setting'
      ? codexType(option.type)
      : {
          valueType: option.type === 'boolean' ? ('boolean' as const) : ('string' as const),
          allowed: [],
        };
  return {
    key: option.key,
    kind,
    area: areaOf(option.key.replace(/^--/u, ''), description),
    valueType: typed.valueType,
    defaultValue: option.defaultValue ?? codexDefault(option.description),
    allowed: typed.allowed,
    description,
    docUrl: page,
    appliesAt: 'next-launch',
    managedOnly: false,
  };
}

/** Every knob, settings first, each key once, placeholders left out. */
export function buildCodexCatalog(pages: CodexReferencePages): readonly KnobDefinition[] {
  const settings = parseConfigTables(configTomlSection(pages.configReference)).map((option) =>
    knob(option, 'setting', CONFIG_REFERENCE_URL),
  );
  const env = parseEnvTables(pages.environment).map((option) =>
    knob(option, 'env', ENVIRONMENT_URL),
  );
  const flags = parseGlobalFlags(pages.commandsHtml).map((option) =>
    knob(option, 'flag', COMMANDS_URL),
  );
  const seen = new Set<string>();
  return [...settings, ...env, ...flags].filter((item) => {
    const id = `${item.kind}:${item.key}`;
    if (item.key.includes('<') || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}
