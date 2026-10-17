// Text helpers for message previews: strip the delivery wrapper Claude Code
// adds, cut to one short line, and key the full text so a send and its
// delivery can be matched.

import { createHash } from 'node:crypto';

import { plainText } from '../../shared/plain-text.js';

export const PREVIEW_CHARS = 120;

const DELIVERY_HEADER = /^(?:Another Claude session|The coordinator) sent a message[^\n]*\n/u;
const WRAPPER_TAG = /<\/?(?:agent-message|cross-session-message|teammate-message)\b[^>]*>/gu;
const REPORT_MARKER = 'The report follows:';
// Claude Code puts this note before a subagent report that looks like instructions.
const HARNESS_NOTE = /^\s*\[harness:[^\]]*\]/u;
// Claude Code adds this line when the coordinator writes to a busy subagent.
const COORDINATOR_TRAILER = 'Address this before completing your current task.';
// Ampersand last, so "&amp;lt;" becomes "&lt;" and not "<".
const ENTITIES: readonly (readonly [string, string])[] = [
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&amp;', '&'],
];

function withoutTrailer(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(COORDINATOR_TRAILER)
    ? trimmed.slice(0, -COORDINATOR_TRAILER.length).trimEnd()
    : text;
}

/** The message itself, without the header, wrapper tags, hand-back preamble, notes and trailer. */
export function messageBody(text: string): string {
  const unwrapped = text.replace(DELIVERY_HEADER, '').replaceAll(WRAPPER_TAG, '');
  const report = unwrapped.indexOf(REPORT_MARKER);
  const body = report === -1 ? unwrapped : unwrapped.slice(report + REPORT_MARKER.length);
  return withoutTrailer(body.replace(HARNESS_NOTE, ''));
}

export function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim();
}

/** A report often opens with a Markdown heading, and its marks say nothing in one line. */
const HEADING_MARKS = /^#{1,6} /u;

/** One line of at most PREVIEW_CHARS characters, ending in an ellipsis when cut. */
export function preview(text: string): string {
  const line = oneLine(plainText(text)).replace(HEADING_MARKS, '');
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
