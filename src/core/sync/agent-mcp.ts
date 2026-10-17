// MCP servers from the config repo, added through each agent's own MCP store
// (ConfigFacet.mcp) instead of a CLI call written here. The repo keeps every
// agent's servers in the shape .mcp.json uses, with secrets as placeholders.

import type { McpServerConfig } from '../agents/types.js';

import { isArray, isRecord, type JsonRecord, stringRecord } from './json.js';

function stringList(value: unknown): readonly string[] | null {
  return isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function optionalStrings(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every((item) => typeof item === 'string'))
  );
}

/** True when the record already is a server config the stores take, extra keys and all. */
function isServerConfig(value: JsonRecord): value is JsonRecord & McpServerConfig {
  const type = value['type'];
  if (type === 'stdio') {
    return (
      typeof value['command'] === 'string' &&
      stringList(value['args']) !== null &&
      optionalStrings(value['env'])
    );
  }
  if (type === 'http' || type === 'sse') {
    return typeof value['url'] === 'string' && optionalStrings(value['headers']);
  }
  return false;
}

function typeOf(config: JsonRecord): string | undefined {
  const type = config['type'];
  // Copilot calls a command server "local".
  if (type === 'local' || (type === undefined && typeof config['command'] === 'string')) {
    return 'stdio';
  }
  if (type === undefined && typeof config['url'] === 'string') {
    return 'http';
  }
  return typeof type === 'string' ? type : undefined;
}

/**
 * A repo server config as the MCP stores take it. Keys the stores do not know
 * stay, so Claude Code's add-json still gets every field. Null when it is
 * neither a command nor a URL server.
 */
export function serverConfigFor(config: unknown): McpServerConfig | null {
  if (!isRecord(config)) {
    return null;
  }
  const filled: JsonRecord = {
    ...config,
    type: typeOf(config),
    ...(config['args'] === undefined && typeof config['command'] === 'string' ? { args: [] } : {}),
  };
  return isServerConfig(filled) ? filled : null;
}

/** The parts of a server every agent's add can set, for telling whether two configs are the same server. */
export function serverCore(config: JsonRecord): JsonRecord | null {
  const server = serverConfigFor(config);
  if (server === null) {
    return null;
  }
  if (server.type === 'stdio') {
    return {
      type: 'stdio',
      command: server.command,
      args: [...server.args],
      env: stringRecord(server.env),
    };
  }
  return { type: server.type, url: server.url, headers: stringRecord(server.headers) };
}
