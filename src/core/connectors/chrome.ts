// Claude in Chrome is built into Claude Code, so `claude mcp list` leaves it
// out. Its server runs with `claude --claude-in-chrome-mcp`, and asking that
// server for list_connected_browsers says whether a Chrome with the Claude
// extension is attached to this account right now.

import type { Connector } from '../../shared/connectors.js';

export const CHROME_MCP_FLAG = '--claude-in-chrome-mcp';
export const CHROME_TOOL = 'list_connected_browsers';
const CHROME_NAME = 'Claude in Chrome';

interface Browser {
  readonly name: string;
  readonly here: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

/** The browsers in the tool's answer. Throws when it is not a JSON list. */
export function parseBrowsers(text: string): Browser[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) {
    throw new TypeError('list_connected_browsers did not answer with a list');
  }
  const entries: readonly unknown[] = value;
  return entries.filter(isRecord).map((entry) => ({
    name: stringField(entry, ['displayName', 'name', 'deviceName', 'deviceId']) || 'Chrome',
    here: entry['onThisComputer'] === true || entry['isLocal'] === true,
  }));
}

function connector(fields: Pick<Connector, 'status' | 'detail' | 'fix'>): Connector {
  return {
    id: 'chrome:claude-in-chrome',
    name: CHROME_NAME,
    kind: 'chrome',
    target: 'Chrome extension',
    ...fields,
  };
}

function describe(browsers: readonly Browser[]): string {
  const names = browsers.map(
    (browser) => `${browser.name}${browser.here ? ' (this computer)' : ''}`,
  );
  return `Connected: ${names.join(', ')}.`;
}

export interface ChromeInput {
  /** The text list_connected_browsers answered with, or the error the probe hit. */
  readonly answer: { readonly text: string } | { readonly error: string };
  /** From ~/.claude.json; null when Claude Code has not recorded it. */
  readonly extensionInstalled: boolean | null;
}

export function chromeConnector(input: ChromeInput): Connector {
  if (input.extensionInstalled === false) {
    return connector({
      status: 'missing',
      detail:
        'The Claude in Chrome extension is not installed. Run /chrome in Claude Code to set it up.',
      fix: null,
    });
  }
  if ('error' in input.answer) {
    return connector({
      status: 'failed',
      detail: `Could not ask Claude Code which browsers are connected: ${input.answer.error}`,
      fix: null,
    });
  }
  let browsers: Browser[];
  try {
    browsers = parseBrowsers(input.answer.text);
  } catch (error) {
    return connector({
      status: 'unknown',
      detail: error instanceof Error ? error.message : String(error),
      fix: null,
    });
  }
  if (browsers.length === 0) {
    return connector({
      status: 'missing',
      detail:
        'No Chrome is connected. Open Chrome and check that the Claude extension is signed in to this account.',
      fix: 'open-chrome',
    });
  }
  return connector({ status: 'ok', detail: describe(browsers), fix: null });
}
