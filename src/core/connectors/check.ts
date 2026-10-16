// One check of every connector: the MCP servers and claude.ai connectors from
// `claude mcp list`, Claude in Chrome from its own server, and a headless
// Chrome on disk. The three run side by side, and each failure becomes a row
// that says what went wrong instead of failing the whole check.

import { readFile } from 'node:fs/promises';

import type { Connector } from '../../shared/connectors.js';
import type { Exec } from '../sync/exec.js';

import { CHROME_MCP_FLAG, CHROME_TOOL, chromeConnector } from './chrome.js';
import { findHeadlessChrome, headlessConnector } from './headless.js';
import { parseMcpList } from './mcp-list.js';
import type { StdioToolCaller } from './stdio-mcp.js';

/** `claude mcp list` checks every server in parallel, each with its own timeout. */
export const MCP_LIST_TIMEOUT_MS = 90_000;
export const CHROME_TIMEOUT_MS = 20_000;

export interface CheckInput {
  readonly bin: string;
  readonly env: Readonly<Record<string, string>>;
  /** Where `claude mcp list` runs, which decides the project scoped servers. */
  readonly cwd: string;
  readonly home: string;
  readonly claudeJson: string;
  readonly platform: NodeJS.Platform;
  readonly exec: Exec;
  readonly callTool: StdioToolCaller;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mcpServers(input: CheckInput): Promise<Connector[]> {
  const result = await input.exec(input.bin, ['mcp', 'list'], {
    cwd: input.cwd,
    env: input.env,
    timeoutMs: MCP_LIST_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `claude mcp list exited ${String(result.code)}`;
    return [
      {
        id: 'mcp:list',
        name: 'MCP servers',
        kind: 'mcp',
        target: 'claude mcp list',
        status: 'failed',
        detail: `Could not list the MCP servers: ${detail}`,
        fix: null,
      },
    ];
  }
  return parseMcpList(result.stdout);
}

/** cachedChromeExtensionInstalled from ~/.claude.json, or null when it is not there. */
export async function extensionInstalled(claudeJson: string): Promise<boolean | null> {
  try {
    const value: unknown = JSON.parse(await readFile(claudeJson, 'utf8'));
    if (typeof value === 'object' && value !== null && 'cachedChromeExtensionInstalled' in value) {
      const installed = value.cachedChromeExtensionInstalled;
      return typeof installed === 'boolean' ? installed : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function chrome(input: CheckInput): Promise<Connector> {
  const installed = await extensionInstalled(input.claudeJson);
  if (installed === false) {
    return chromeConnector({ answer: { text: '[]' }, extensionInstalled: false });
  }
  let answer: { readonly text: string } | { readonly error: string };
  try {
    answer = {
      text: await input.callTool({
        command: input.bin,
        args: [CHROME_MCP_FLAG],
        env: input.env,
        cwd: input.home,
        tool: CHROME_TOOL,
        timeoutMs: CHROME_TIMEOUT_MS,
      }),
    };
  } catch (error) {
    answer = { error: messageOf(error) };
  }
  return chromeConnector({ answer, extensionInstalled: installed });
}

export async function checkConnectors(input: CheckInput): Promise<Connector[]> {
  const [browser, headless, servers] = await Promise.all([
    chrome(input),
    findHeadlessChrome({ home: input.home, platform: input.platform, env: input.env }),
    mcpServers(input),
  ]);
  return [browser, headlessConnector(headless), ...servers];
}
