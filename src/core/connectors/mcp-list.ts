// Reads the text `claude mcp list` prints. It has no JSON mode, so each line
// is "name: target - <mark> Status", and statuses are matched by keyword so a
// change of wording shows up as unknown instead of as the wrong answer.

import type { Connector, ConnectorStatus } from '../../shared/connectors.js';

const CLAUDE_AI_PREFIX = 'claude.ai ';
const STATUS_SEPARATOR = ' - ';
const NAME_SEPARATOR = ': ';

/** The status a line ends with, from its words. */
export function statusFrom(text: string): ConnectorStatus {
  const words = text.toLowerCase();
  if (words.includes('auth')) {
    return 'needs-auth';
  }
  if (words.includes('pending')) {
    return 'pending';
  }
  if (words.includes('disabled')) {
    return 'disabled';
  }
  if (words.includes('not configured')) {
    return 'missing';
  }
  if (words.includes('fail') || words.includes('error') || words.includes('not connected')) {
    return 'failed';
  }
  if (words.includes('connected')) {
    return 'ok';
  }
  return 'unknown';
}

const DETAILS: Readonly<Record<ConnectorStatus, string>> = {
  ok: 'Connected.',
  'needs-auth': 'Needs a sign in before a session can use it.',
  failed: 'Claude Code could not connect to it.',
  pending: 'Waiting for you to approve this project .mcp.json server in a Claude Code session.',
  disabled: 'Turned off for this project.',
  missing: 'Not set up.',
  unknown: 'Claude Code reported a status Overlord does not know.',
  unchecked: 'Set up, but not checked.',
};

/** The status words after the mark, for example "Failed to connect". */
function statusWords(text: string): string {
  return text.replace(/^\P{L}+/u, '').trim();
}

function parseLine(line: string): Connector | null {
  const nameEnd = line.indexOf(NAME_SEPARATOR);
  const statusStart = line.lastIndexOf(STATUS_SEPARATOR);
  if (nameEnd <= 0 || statusStart <= nameEnd) {
    return null;
  }
  const name = line.slice(0, nameEnd).trim();
  const target = line.slice(nameEnd + NAME_SEPARATOR.length, statusStart).trim();
  const words = statusWords(line.slice(statusStart + STATUS_SEPARATOR.length));
  const status = statusFrom(words);
  const kind = name.startsWith(CLAUDE_AI_PREFIX) ? 'claude.ai' : 'mcp';
  return {
    id: `${kind}:${name}`,
    name,
    kind,
    target,
    status,
    detail: status === 'unknown' ? `${DETAILS.unknown} It said: ${words}` : DETAILS[status],
    // HTTP servers and claude.ai connectors sign in with `claude mcp login`.
    fix: status === 'needs-auth' ? 'sign-in' : null,
  };
}

/** One connector per server line. Headings, blank lines and notes are skipped. */
export function parseMcpList(output: string): Connector[] {
  return output
    .split(/\r?\n/u)
    .map((line) => parseLine(line.trim()))
    .filter((connector): connector is Connector => connector !== null);
}
