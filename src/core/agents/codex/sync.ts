// What config sync keeps for Codex CLI under agents/codex/ in the config repo:
// AGENTS.md, skills, the settings in config.toml key by key, and the user MCP
// servers. config.toml is never copied whole. Its keys are set one at a time
// through knobs/toml-edit.ts so the comments in it stay, and auth.json,
// history, sessions, logs and the sqlite files never sync.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'smol-toml';

import { isRecord } from '../../connectors/mcp-files.js';
import type { SyncedMcpServer, SyncFacet } from '../sync-types.js';

import { codexHome } from './mcp.js';

// MCP servers go through `codex mcp add` instead. Trusted projects are paths
// on this machine, and Overlord writes [otel] for its own port on each one.
const LOCAL_TABLES: ReadonlySet<string> = new Set(['mcp_servers', 'projects', 'otel']);

type Table = Readonly<Record<string, unknown>>;

function strings(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** A [mcp_servers.<name>] table in the shape .mcp.json uses. Null when it is neither kind. */
function asServerJson(table: Table): Table | null {
  const env = strings(table['env']);
  const headers = strings(table['http_headers']);
  if (typeof table['command'] === 'string') {
    const args = Array.isArray(table['args'])
      ? table['args'].filter((argument): argument is string => typeof argument === 'string')
      : [];
    return {
      type: 'stdio',
      command: table['command'],
      args,
      ...(env === undefined ? {} : { env }),
    };
  }
  if (typeof table['url'] === 'string') {
    return { type: 'http', url: table['url'], ...(headers === undefined ? {} : { headers }) };
  }
  return null;
}

async function readServers(dir: string): Promise<readonly SyncedMcpServer[] | null> {
  let text: string;
  try {
    text = await readFile(path.join(dir, 'config.toml'), 'utf8');
  } catch (error: unknown) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return missing ? [] : null;
  }
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return null;
  }
  const servers = isRecord(parsed) ? parsed['mcp_servers'] : undefined;
  if (!isRecord(servers)) {
    return [];
  }
  return Object.entries(servers).flatMap(([name, table]) => {
    const config = isRecord(table) ? asServerJson(table) : null;
    return config === null ? [] : [{ name, config }];
  });
}

export const codexSync: SyncFacet = {
  dir: codexHome,
  files: [{ kind: 'claude-md', file: 'AGENTS.md' }],
  folders: [{ kind: 'skill', dir: 'skills', entries: 'dirs' }],
  settings: {
    file: 'config.toml',
    format: 'toml',
    repoName: 'config.json',
    local: (keyPath) => LOCAL_TABLES.has(keyPath[0] ?? ''),
  },
  mcp: { file: 'config.toml', read: readServers },
};
