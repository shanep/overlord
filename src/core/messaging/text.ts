// Text helpers for message previews: strip the delivery wrapper Claude Code
// adds, cut to one short line, and key the full text so a send and its
// delivery can be matched.

import { createHash } from 'node:crypto';

export const PREVIEW_CHARS = 120;

const DELIVERY_HEADER = /^(?:Another Claude session|The coordinator) sent a message[^\n]*\n/u;
const WRAPPER_TAG = /<\/?(?:agent-message|cross-session-message|teammate-message)\b[^>]*>/gu;
const REPORT_MARKER = 'The report follows:';
// Ampersand last, so "&amp;lt;" becomes "&lt;" and not "<".
const ENTITIES: readonly (readonly [string, string])[] = [
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&amp;', '&'],
];

/** The message itself, without the header, wrapper tags or hand-back preamble. */
export function messageBody(text: string): string {
  const unwrapped = text.replace(DELIVERY_HEADER, '').replaceAll(WRAPPER_TAG, '');
  const report = unwrapped.indexOf(REPORT_MARKER);
  return report === -1 ? unwrapped : unwrapped.slice(report + REPORT_MARKER.length);
}

export function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim();
}

/** One line of at most PREVIEW_CHARS characters, ending in an ellipsis when cut. */
export function preview(text: string): string {
  const line = oneLine(text);
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

/** A short hash of the whitespace-normalized text. */
export function textKey(text: string): string {
  return createHash('sha256').update(oneLine(text)).digest('hex').slice(0, 16);
}

export function decodeEntities(text: string): string {
  let result = text;
  for (const [entity, plain] of ENTITIES) {
    result = result.replaceAll(entity, plain);
  }
  return result;
}

/** The text inside the first <tag>...</tag>, or null. */
export function tagText(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) {
    return null;
  }
  const end = text.indexOf(`</${tag}>`, start);
  return end === -1 ? null : decodeEntities(text.slice(start + open.length, end));
}
