// Copilot CLI's MCP store. `copilot mcp --help` lists where it reads servers
// from: ~/.copilot/mcp-config.json (or $COPILOT_HOME) for the user, and the
// folder's .mcp.json or .github/mcp.json, all with an `mcpServers` object.
// Servers turned off with `copilot mcp disable` are named in the
// disabledMcpServers list of its settings. Copilot reports no health, so its
// rows say they are set up but not checked. Add and remove go through
// `copilot mcp add` and `copilot mcp remove`, which only write the user file.

import path from 'node:path';

import { COPILOT } from '../../../shared/agents.js';
import type { Connector } from '../../../shared/connectors.js';
import { runMcpCommand } from '../../connectors/mcp-cli.js';
import {
  byPrecedence,
  errorRow,
  fileRow,
  isRecord,
  readJsonFile,
  readServerFile,
  stringList,
} from '../../connectors/mcp-files.js';
import type {
  McpPlace,
  McpRead,
  McpServer,
  McpServerConfig,
  McpStore,
  SettingsWriteResult,
  ShellEnv,
} from '../types.js';

const SHORT = 'Copilot';

/** $COPILOT_HOME, or ~/.copilot. */
export function copilotHome(home: string, env: ShellEnv): string {
  const set = env['COPILOT_HOME'];
  return set === undefined || set === '' ? path.join(home, '.copilot') : set;
}

/** Names turned off in Copilot's settings. Its own files start with line comments. */
async function disabledNames(dir: string): Promise<ReadonlySet<string>> {
  const files = await Promise.all(
    ['settings.json', 'config.json'].map(async (name) => readJsonFile(path.join(dir, name), true)),
  );
  return new Set(
    files.flatMap((file) =>
      'error' in file || !isRecord(file.value) ? [] : stringList(file.value['disabledMcpServers']),
    ),
  );
}

async function read(place: McpPlace): Promise<McpRead> {
  const dir = copilotHome(place.home, place.env);
  const disabled = await disabledNames(dir);
  const state = (name: string): McpServer['state'] => (disabled.has(name) ? 'off' : 'on');
  const files = [
    ...(place.cwd === null
      ? []
      : [
          { file: path.join(place.cwd, '.mcp.json'), scope: 'project' as const },
          { file: path.join(place.cwd, '.github', 'mcp.json'), scope: 'project' as const },
        ]),
    { file: path.join(dir, 'mcp-config.json'), scope: 'user' as const },
  ];
  const reads = await Promise.all(
    files.map(async (entry) => readServerFile(entry.file, { scope: entry.scope, state })),
  );
  return {
    servers: reads.flatMap((entry) => entry.servers),
    errors: reads.flatMap((entry) => (entry.error === null ? [] : [entry.error])),
  };
}

async function list(input: { readonly place: McpPlace }): Promise<Connector[]> {
  const found = await read(input.place);
  const rows = byPrecedence(found.servers).map((server) =>
    fileRow(COPILOT, server, { short: SHORT, where: (entry) => entry.file }),
  );
  return found.errors.length === 0
    ? rows
    : [...rows, errorRow(COPILOT, SHORT, found.errors.join('; '))];
}

/** The `copilot mcp add` args for a server, options first. */
export function addArgs(name: string, server: McpServerConfig): string[] {
  if (server.type === 'stdio') {
    const env = Object.entries(server.env ?? {}).flatMap(([key, value]) => [
      '--env',
      `${key}=${value}`,
    ]);
    return ['mcp', 'add', ...env, name, '--', server.command, ...server.args];
  }
  const headers = Object.entries(server.headers ?? {}).flatMap(([key, value]) => [
    '--header',
    `${key}: ${value}`,
  ]);
  return ['mcp', 'add', '--transport', server.type, ...headers, name, server.url];
}

function userOnly(scope: string): SettingsWriteResult | null {
  return scope === 'user'
    ? null
    : { ok: false, error: `${SHORT} adds and removes servers in the user file only.` };
}

export const copilotMcp: McpStore = {
  scopes: ['user'],
  read,
  list,
  add: async (input) =>
    userOnly(input.scope) ??
    runMcpCommand(input, addArgs(input.name, input.server), 'copilot mcp add'),
  remove: async (input) =>
    userOnly(input.scope) ??
    runMcpCommand(input, ['mcp', 'remove', input.name], 'copilot mcp remove'),
};
