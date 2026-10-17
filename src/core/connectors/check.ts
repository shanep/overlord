// One check of every connector: each agent's MCP servers from its MCP store
// (for Claude Code that includes the claude.ai connectors `claude mcp list`
// reports), Claude in Chrome from its own server, and a headless Chrome on
// disk. They run side by side, and each failure becomes a row that says what
// went wrong instead of failing the whole check.

import { readFile } from 'node:fs/promises';

import type { AgentId } from '../../shared/agents.js';
import type { Connector } from '../../shared/connectors.js';
import type { AgentCli, McpPlace, McpStore } from '../agents/types.js';
import type { Exec } from '../sync/exec.js';

import { CHROME_MCP_FLAG, CHROME_TOOL, chromeConnector } from './chrome.js';
import { findHeadlessChrome, headlessConnector } from './headless.js';
import type { StdioToolCaller } from './stdio-mcp.js';

export const CHROME_TIMEOUT_MS = 20_000;

/** One agent's MCP store and the binary its CLI runs as. */
export interface McpSource {
  readonly agent: AgentId;
  readonly store: McpStore;
  readonly cli: AgentCli;
}

export interface CheckInput {
  /** Claude Code's binary, which serves Claude in Chrome, or null to leave Chrome out. */
  readonly claude: AgentCli | null;
  /** Each agent's servers, in order. Claude Code's come first. */
  readonly mcp: readonly McpSource[];
  /** Where the agents' files are and the folder that decides the project servers. */
  readonly place: McpPlace;
  /** Where the MCP commands run. */
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

async function mcpServers(input: CheckInput, source: McpSource): Promise<Connector[]> {
  try {
    return await source.store.list({
      exec: input.exec,
      cli: source.cli,
      cwd: input.cwd,
      place: input.place,
    });
  } catch (error) {
    return [
      {
        id: `${source.agent}/mcp:list`,
        name: 'MCP servers',
        kind: 'mcp',
        target: '',
        status: 'failed',
        detail: `Could not list the MCP servers: ${messageOf(error)}`,
        fix: null,
        agent: source.agent,
      },
    ];
  }
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

async function chrome(input: CheckInput, cli: AgentCli): Promise<Connector> {
  const installed = await extensionInstalled(input.claudeJson);
  if (installed === false) {
    return chromeConnector({ answer: { text: '[]' }, extensionInstalled: false });
  }
  let answer: { readonly text: string } | { readonly error: string };
  try {
    answer = {
      text: await input.callTool({
        command: cli.bin,
        args: [CHROME_MCP_FLAG],
        env: cli.env,
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
    input.claude === null ? null : chrome(input, input.claude),
    findHeadlessChrome({
      home: input.home,
      platform: input.platform,
      env: input.claude?.env ?? input.place.env,
    }),
    Promise.all(input.mcp.map(async (source) => mcpServers(input, source))),
  ]);
  return [...(browser === null ? [] : [browser]), headlessConnector(headless), ...servers.flat()];
}
