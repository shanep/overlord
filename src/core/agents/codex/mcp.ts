// Codex CLI's MCP store. Codex keeps servers as [mcp_servers.<name>] tables in
// $CODEX_HOME/config.toml (~/.codex/config.toml), and a trusted project can
// add its own in .codex/config.toml. Overlord only reads that file here and
// never writes it: add and remove go through `codex mcp add` and
// `codex mcp remove`, which edit the user file themselves. Codex reports no
// health, so its rows say they are set up but not checked.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'smol-toml';

import { CODEX } from '../../../shared/agents.js';
import type { Connector } from '../../../shared/connectors.js';
import { runMcpCommand } from '../../connectors/mcp-cli.js';
import { byPrecedence, errorRow, fileRow, isRecord, targetOf } from '../../connectors/mcp-files.js';
import type {
  McpPlace,
  McpRead,
  McpScope,
  McpServer,
  McpServerConfig,
  McpStore,
  SettingsWriteResult,
} from '../types.js';

import { codexHome } from './observer.js';

const SHORT = 'Codex';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The servers in one config.toml, which may not exist. */
async function readToml(
  file: string,
  scope: McpScope,
): Promise<{ readonly servers: McpServer[]; readonly error: string | null }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return { servers: [], error: missing ? null : `${file}: ${messageOf(error)}` };
  }
  let table: unknown;
  try {
    table = parse(text);
  } catch (error) {
    return { servers: [], error: `${file}: ${messageOf(error)}` };
  }
  const servers = isRecord(table) ? table['mcp_servers'] : undefined;
  if (!isRecord(servers)) {
    return { servers: [], error: null };
  }
  return {
    servers: Object.entries(servers).flatMap(([name, config]) => {
      if (!isRecord(config)) {
        return [];
      }
      const transport = typeof config['url'] === 'string' ? 'http' : 'stdio';
      return [
        {
          name,
          scope,
          file,
          transport,
          target: targetOf(config, transport),
          state: config['enabled'] === false ? 'off' : 'on',
        },
      ];
    }),
    error: null,
  };
}

async function read(place: McpPlace): Promise<McpRead> {
  const files = [
    ...(place.cwd === null
      ? []
      : [{ file: path.join(place.cwd, '.codex', 'config.toml'), scope: 'project' as const }]),
    { file: path.join(codexHome(place), 'config.toml'), scope: 'user' as const },
  ];
  const reads = await Promise.all(files.map(async (entry) => readToml(entry.file, entry.scope)));
  return {
    servers: reads.flatMap((entry) => entry.servers),
    errors: reads.flatMap((entry) => (entry.error === null ? [] : [entry.error])),
  };
}

async function list(input: { readonly place: McpPlace }): Promise<Connector[]> {
  const found = await read(input.place);
  const rows = byPrecedence(found.servers).map((server) =>
    fileRow(CODEX, server, { short: SHORT, where: (entry) => entry.file }),
  );
  return found.errors.length === 0
    ? rows
    : [...rows, errorRow(CODEX, SHORT, found.errors.join('; '))];
}

/** The args for `codex mcp add`, or why Codex cannot take the server. */
type AddArgs = { readonly args: readonly string[] } | { readonly error: string };

/**
 * The `codex mcp add` args for a server. Its add sets a command with
 * variables, or a streamable HTTP URL with no headers, so anything else is
 * left for the user to put in config.toml.
 */
export function addArgs(name: string, server: McpServerConfig): AddArgs {
  if (server.type === 'stdio') {
    const env = Object.entries(server.env ?? {}).flatMap(([key, value]) => [
      '--env',
      `${key}=${value}`,
    ]);
    return { args: ['mcp', 'add', ...env, name, '--', server.command, ...server.args] };
  }
  if (server.type === 'sse') {
    return { error: 'Codex connects to remote servers over streamable HTTP only, not SSE.' };
  }
  if (Object.keys(server.headers ?? {}).length > 0) {
    return {
      error:
        'codex mcp add cannot set headers. Add the server to ~/.codex/config.toml with http_headers yourself.',
    };
  }
  return { args: ['mcp', 'add', name, '--url', server.url] };
}

function userOnly(scope: McpScope): SettingsWriteResult | null {
  return scope === 'user'
    ? null
    : { ok: false, error: `${SHORT} adds and removes servers in the user config.toml only.` };
}

export const codexMcp: McpStore = {
  scopes: ['user'],
  read,
  list,
  add: async (input) => {
    const built = addArgs(input.name, input.server);
    if ('error' in built) {
      return { ok: false, error: built.error };
    }
    return userOnly(input.scope) ?? runMcpCommand(input, built.args, 'codex mcp add');
  },
  remove: async (input) =>
    userOnly(input.scope) ??
    runMcpCommand(input, ['mcp', 'remove', input.name], 'codex mcp remove'),
  signInArgs: (name) => ['mcp', 'login', name],
};
