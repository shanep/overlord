// YAML frontmatter between `---` lines at the top of a markdown file.

import { parse } from 'yaml';

export interface Frontmatter {
  /** Parsed YAML, or the lenient `key: value` reading when the YAML is invalid. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly body: string;
  /** The YAML parse error, when the block was present but invalid. */
  readonly error: string | null;
}

const LOOSE_KEY = /^([\w-]+):(.*)$/u;
const QUOTED = /^(["'])(.*)\1$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMarker(line: string | undefined): boolean {
  return line?.trim() === '---';
}

function looseValue(raw: string): unknown {
  const value = raw.trim();
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  return QUOTED.exec(value)?.[2] ?? value;
}

/**
 * Skill authors often write `description: text with: a colon`, which is not
 * valid YAML, and Claude Code still reads it. This reads top-level
 * `key: value` lines and `- item` lists the same forgiving way.
 */
export function parseLoose(yamlText: string): Record<string, unknown> {
  // A Map, then fromEntries, so a `__proto__` key cannot touch a prototype.
  const out = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  let listKey: string | null = null;
  for (const line of yamlText.split('\n')) {
    const match = LOOSE_KEY.exec(line.trimEnd());
    const item = line.trim();
    if (match?.[1] !== undefined && match[2] !== undefined) {
      out.set(match[1], looseValue(match[2]));
      listKey = match[2].trim() === '' ? match[1] : null;
    } else if (listKey !== null && item.startsWith('- ')) {
      const list: unknown[] = lists.get(listKey) ?? [];
      list.push(looseValue(item.slice(2)));
      lists.set(listKey, list);
      out.set(listKey, list);
    }
  }
  return Object.fromEntries(out);
}

export function parseFrontmatter(text: string): Frontmatter {
  // trim() also strips a leading BOM, so the marker check needs no special case.
  const clean = text.replaceAll('\r\n', '\n');
  const lines = clean.split('\n');
  const end = lines.findIndex((line, index) => index > 0 && isMarker(line));
  if (!isMarker(lines[0]) || end === -1) {
    return { data: {}, body: clean, error: null };
  }
  const yamlText = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  try {
    const parsed: unknown = parse(yamlText);
    return { data: isRecord(parsed) ? parsed : {}, body, error: null };
  } catch (error: unknown) {
    return { data: parseLoose(yamlText), body, error: String(error) };
  }
}

/** Splits on commas that sit outside `{...}` brace groups. */
function splitOutsideBraces(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** A `paths` style field: a YAML list or one comma-separated string. */
export function readStringList(value: unknown): string[] {
  let items: unknown[] = [];
  if (typeof value === 'string') {
    items = splitOutsideBraces(value);
  } else if (Array.isArray(value)) {
    items = value;
  }
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string' && item.trim() !== '') {
      out.push(item.trim());
    }
  }
  return out;
}

export function readFlag(value: unknown): boolean {
  return value === true || value === 'true';
}

export function readText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
