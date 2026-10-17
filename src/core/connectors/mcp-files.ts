// Reads the JSON files agents keep MCP servers in. Claude Code and Copilot
// both use an `mcpServers` object keyed by name, with a command and args for
// a local server or a URL for a remote one, so one reader serves both. Also
// turns servers into rows for agents whose CLI reports no health.

import { readFile } from 'node:fs/promises';

import type { AgentId } from '../../shared/agents.js';
import type { Connector } from '../../shared/connectors.js';
import type { McpScope, McpServer } from '../agents/types.js';

type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** A JSON file's value, null when the file is not there, or why it could not be read. */
type JsonFile = { readonly value: unknown } | { readonly value: null } | { readonly error: string };

/** The text without its line comments, which Copilot's own JSON files start with. */
function withoutLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

export async function readJsonFile(file: string, comments = false): Promise<JsonFile> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return isMissing(error) ? { value: null } : { error: `${file}: ${messageOf(error)}` };
  }
  try {
    const value: unknown = JSON.parse(comments ? withoutLineComments(text) : text);
    return { value };
  } catch (error) {
    return { error: `${file}: ${messageOf(error)}` };
  }
}

/** The strings in a list, skipping anything else. */
export function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: readonly unknown[] = value;
  return items.filter((item): item is string => typeof item === 'string');
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Local servers say stdio or, in Copilot, local. A server with only a URL is remote over HTTP. */
function transportOf(config: JsonRecord): McpServer['transport'] {
  const type = stringOf(config['type']).toLowerCase();
  if (type === 'sse') {
    return 'sse';
  }
  if (type === 'http' || type === 'streamable-http') {
    return 'http';
  }
  if (type === '' && typeof config['url'] === 'string' && config['command'] === undefined) {
    return 'http';
  }
  return 'stdio';
}

/** The command line or URL a server's config names. */
export function targetOf(config: JsonRecord, transport: McpServer['transport']): string {
  if (transport !== 'stdio') {
    return stringOf(config['url']);
  }
  return [stringOf(config['command']), ...stringList(config['args'])]
    .filter((word) => word !== '')
    .join(' ');
}

interface ServerSource {
  readonly scope: McpScope;
  readonly file: string;
  /** Whether a server is on, by name. */
  readonly state: (name: string) => McpServer['state'];
}

/** The servers in an `mcpServers` object, in the order the file lists them. */
export function serversIn(servers: unknown, source: ServerSource): McpServer[] {
  if (!isRecord(servers)) {
    return [];
  }
  return Object.entries(servers).flatMap(([name, config]) => {
    if (!isRecord(config)) {
      return [];
    }
    const transport = transportOf(config);
    return [
      {
        name,
        scope: source.scope,
        file: source.file,
        transport,
        target: targetOf(config, transport),
        state: source.state(name),
      },
    ];
  });
}

/** The servers a JSON file holds under key, and the error when it will not parse. */
export async function readServerFile(
  file: string,
  source: Omit<ServerSource, 'file'>,
  keys: readonly string[] = ['mcpServers'],
): Promise<{ readonly servers: McpServer[]; readonly error: string | null }> {
  const read = await readJsonFile(file);
  if ('error' in read) {
    return { servers: [], error: read.error };
  }
  if (!isRecord(read.value)) {
    return { servers: [], error: null };
  }
  const { value } = read;
  const key = keys.find((name) => isRecord(value[name]));
  return {
    servers: key === undefined ? [] : serversIn(value[key], { ...source, file }),
    error: null,
  };
}

/** A later scope's server hides an earlier one of the same name, the way agents resolve them. */
export function byPrecedence(servers: readonly McpServer[]): McpServer[] {
  const seen = new Set<string>();
  return servers.filter((server) => {
    if (seen.has(server.name)) {
      return false;
    }
    seen.add(server.name);
    return true;
  });
}

interface RowWords {
  /** The agent's short name, such as Codex. */
  readonly short: string;
  /** Where it was set up, such as ~/.codex/config.toml, for the detail. */
  readonly where: (server: McpServer) => string;
}

/** A row for a server the agent's CLI does not check, from its file alone. */
export function fileRow(agent: AgentId, server: McpServer, words: RowWords): Connector {
  const where = words.where(server);
  const status = server.state === 'off' ? 'disabled' : 'unchecked';
  return {
    id: `${agent}/mcp:${server.name}`,
    name: server.name,
    kind: 'mcp',
    target: server.target,
    status,
    detail:
      status === 'disabled'
        ? `Turned off in ${words.short}. Set up in ${where}.`
        : `Set up in ${where}. ${words.short} does not report whether it connects, so Overlord does not check it.`,
    fix: null,
    agent,
  };
}

/** A row that says one of the agent's files could not be read. */
export function errorRow(agent: AgentId, short: string, error: string): Connector {
  return {
    id: `${agent}/mcp:files`,
    name: `${short} MCP servers`,
    kind: 'mcp',
    target: '',
    status: 'failed',
    detail: `Could not read the MCP servers: ${error}`,
    fix: null,
    agent,
  };
}
