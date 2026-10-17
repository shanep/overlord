// Pure formatters for numbers, durations, money and times. Every view uses
// these so the same value always reads the same way.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const COMPACT_STEPS: readonly (readonly [number, string])[] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

const ROUND_UP = 0.9995;

function trimDecimal(value: number): string {
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** 950, 1.2K, 34K, 5.6M. Negative values keep their sign. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  for (const [step, suffix] of COMPACT_STEPS) {
    // Step up early when rounding would print 1000 of the smaller unit.
    if (abs >= step * ROUND_UP) {
      return `${sign}${trimDecimal(abs / step)}${suffix}`;
    }
  }
  return `${sign}${trimDecimal(abs)}`;
}

/** 1,234,567 with grouping, for tables where the exact number matters. */
export function formatInteger(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : 'n/a';
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/** 850ms, 12s, 4m 05s, 1h 02m, 3d 4h. Null or negative reads as n/a. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return 'n/a';
  }
  if (ms < SECOND) {
    return `${Math.round(ms).toString()}ms`;
  }
  if (ms < MINUTE) {
    return `${Math.floor(ms / SECOND).toString()}s`;
  }
  if (ms < HOUR) {
    return `${Math.floor(ms / MINUTE).toString()}m ${pad(Math.floor((ms % MINUTE) / SECOND))}s`;
  }
  if (ms < DAY) {
    return `${Math.floor(ms / HOUR).toString()}h ${pad(Math.floor((ms % HOUR) / MINUTE))}m`;
  }
  return `${Math.floor(ms / DAY).toString()}d ${Math.floor((ms % DAY) / HOUR).toString()}h`;
}

/** Plain dollars with no label, for chart axes: $0.42, $12.30, $1.2K. */
export function formatUsd(usd: number): string {
  if (Math.abs(usd) >= 1000) {
    return `$${formatCompact(usd)}`;
  }
  if (usd !== 0 && Math.abs(usd) < 0.01) {
    return '<$0.01';
  }
  return `$${usd.toFixed(2)}`;
}

/** Cost is a client side estimate at list price, so it always says so. */
export function formatCost(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) {
    return 'n/a';
  }
  return `${formatUsd(usd)} est.`;
}

/** 0.42 reads as 42%. Null reads as n/a. */
export function formatPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) {
    return 'n/a';
  }
  return `${Math.round(ratio * 100).toString()}%`;
}

/** Local wall clock time, 24 hour, for feeds and tables. */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Local date and time, for things that may be days old. */
export function formatDateTime(epochMs: number): string {
  const date = new Date(epochMs);
  const day = `${date.getFullYear().toString()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** How long ago, from `now`: just now, 5m ago, 3h ago, 2d ago. */
export function formatAgo(epochMs: number, now: number): string {
  const delta = now - epochMs;
  if (delta < MINUTE) {
    return 'just now';
  }
  if (delta < HOUR) {
    return `${Math.floor(delta / MINUTE).toString()}m ago`;
  }
  if (delta < DAY) {
    return `${Math.floor(delta / HOUR).toString()}h ago`;
  }
  return `${Math.floor(delta / DAY).toString()}d ago`;
}

/** Show any JSON value as short text for a table cell or preview. */
export function formatValue(value: unknown): string {
  if (value === undefined) {
    return 'unset';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

/** "1 key", "3 keys": a count with its noun, plural with s. */
export function plural(count: number, noun: string): string {
  return `${count.toString()} ${noun}${count === 1 ? '' : 's'}`;
}

/** Cut text to `max` characters with a trailing ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

// Terminal escapes that tool output carries: CSI (colors, cursor moves), OSC
// (titles, links) and the two-byte ESC forms.
const ESC = '\u001B';
const CSI = '\u009B';
const BEL = '\u0007';
const CONTROL = /\p{Cc}/u;

/** Index just past a CSI body: parameter and intermediate bytes, then one final byte. */
function csiEnd(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const code = text.codePointAt(index) ?? 0;
    if (code < 0x20 || code > 0x3f) {
      return code >= 0x40 && code <= 0x7e ? index + 1 : index;
    }
    index += 1;
  }
  return index;
}

/** Index just past an OSC body, which ends at BEL or ESC backslash. */
function oscEnd(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === BEL) {
      return index + 1;
    }
    if (text[index] === ESC && text[index + 1] === '\\') {
      return index + 2;
    }
  }
  return text.length;
}

function escapeEnd(text: string, start: number): number {
  if (text[start] === CSI) {
    return csiEnd(text, start + 1);
  }
  const next = text[start + 1];
  if (next === '[') {
    return csiEnd(text, start + 2);
  }
  if (next === ']') {
    return oscEnd(text, start + 2);
  }
  return Math.min(start + 2, text.length);
}

/**
 * Text as a terminal would show it: escapes dropped, a carriage return
 * overwriting its line the way a progress bar does, and no stray control
 * characters left to print as boxes.
 */
export function plainText(text: string): string {
  const lines: string[] = [];
  let line = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === ESC || char === CSI) {
      index = escapeEnd(text, index);
      continue;
    }
    if (char === '\n') {
      lines.push(line);
      line = '';
    } else if (char === '\r') {
      line = text[index + 1] === '\n' ? line : '';
    } else if (char === '\t' || !CONTROL.test(char)) {
      line += char;
    }
    index += 1;
  }
  lines.push(line);
  return lines.join('\n');
}

const BYTE_STEPS: readonly (readonly [number, string])[] = [
  [1024 ** 4, 'TB'],
  [1024 ** 3, 'GB'],
  [1024 ** 2, 'MB'],
  [1024, 'KB'],
];

/** 512 B, 3.4 KB, 12 MB, 1.5 GB, in powers of 1024 like Activity Monitor. Null reads as n/a. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) {
    return 'n/a';
  }
  for (const [step, unit] of BYTE_STEPS) {
    if (bytes >= step * ROUND_UP) {
      return `${trimDecimal(bytes / step)} ${unit}`;
    }
  }
  return `${Math.round(bytes).toString()} B`;
}

/** Bytes per second: 0 B/s, 3.4 KB/s. Null reads as n/a. */
export function formatRate(bytesPerSec: number | null): string {
  return bytesPerSec === null || !Number.isFinite(bytesPerSec)
    ? 'n/a'
    : `${formatBytes(bytesPerSec)}/s`;
}
