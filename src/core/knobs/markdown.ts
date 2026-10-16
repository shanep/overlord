// Small Markdown helpers for reading the Claude Code docs pages: pipe tables,
// code spans, headings and plain-text cleanup. Only what the catalog needs.

export interface MarkdownTable {
  /** The nearest heading above the table, as written. */
  readonly heading: string;
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

const EN_DASH = String.fromCodePoint(0x20_13);
const EM_DASH = String.fromCodePoint(0x20_14);
const LINK = /!?\[([^[\]]*)\]\([^()\s]*\)/gu;
const HTML_TAG = /(?<!\\)<\/?[a-z][^<>]*>/giu;
const SEPARATOR_CHARS = /^[\s|:-]+$/u;
const HEADING = /^#{1,6} (.+)$/u;

/**
 * Turn a Markdown fragment into one line of plain text: links keep their
 * text, tags and emphasis go, escaped pipes become pipes, and em or en dashes
 * become ", " so nothing downstream ever carries one.
 */
export function cleanText(text: string): string {
  return text
    .replaceAll(LINK, '$1')
    .replaceAll(HTML_TAG, '')
    .replaceAll(String.raw`\|`, '|')
    .replaceAll(String.raw`\<`, '<')
    .replaceAll('`', '')
    .replaceAll('**', '')
    .replaceAll(EN_DASH, EM_DASH)
    .split(EM_DASH)
    .map((part) => part.replaceAll(/\s+/gu, ' ').trim())
    .join(', ');
}

/** The first capture group of `pattern` in `text`, or null when there is none. */
export function capture(pattern: RegExp, text: string): string | null {
  return pattern.exec(text)?.[1] ?? null;
}

/** A table cell by position, or "" when the row is short. */
export function cell(row: readonly string[], index: number): string {
  return row[index] ?? '';
}

/** Every non-empty code span in a fragment, in order, without the backticks. */
export function codeSpans(text: string): readonly string[] {
  return text.split('`').filter((part, index) => index % 2 === 1 && part !== '');
}

/** Drop one pair of surrounding double quotes. */
export function stripQuotes(text: string): string {
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/** The anchor id a docs heading gets, for example "CLI flags" becomes "cli-flags". */
export function slugify(heading: string): string {
  return cleanText(heading)
    .toLowerCase()
    .replaceAll(/[^a-z0-9 -]/gu, '')
    .trim()
    .replaceAll(/\s+/gu, '-');
}

/** Split one table row into trimmed cells, honoring `\|` escapes. */
export function splitRow(line: string): readonly string[] {
  const inner = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return inner.split(/(?<!\\)\|/u).map((part) => part.trim());
}

function isRow(line: string): boolean {
  return line.trim().startsWith('|');
}

/** A row such as "| :- | --- |" under a table header. */
function isSeparatorRow(line: string): boolean {
  return isRow(line) && line.includes('-') && SEPARATOR_CHARS.test(line);
}

interface OpenTable {
  readonly heading: string;
  readonly header: readonly string[];
  readonly rows: (readonly string[])[];
}

/** Every pipe table in the document, with the heading it sits under. */
export function parseTables(markdown: string): readonly MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  let heading = '';
  let previousRow: string | null = null;
  let open: OpenTable | null = null;
  for (const line of markdown.split('\n')) {
    if (open !== null && isRow(line)) {
      open.rows.push(splitRow(line));
      continue;
    }
    if (open !== null) {
      tables.push(open);
      open = null;
    }
    heading = capture(HEADING, line) ?? heading;
    if (previousRow !== null && isSeparatorRow(line)) {
      open = { heading, header: splitRow(previousRow), rows: [] };
      previousRow = null;
    } else {
      previousRow = isRow(line) ? line : null;
    }
  }
  return open === null ? tables : [...tables, open];
}
