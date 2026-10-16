// MCP servers: read from ~/.claude.json (allowlisted key only) or .mcp.json,
// and split secrets out into ${secret:NAME} placeholders for the repo.

import path from 'node:path';

import type { ClaudePaths } from '../paths.js';

import { pickAllowedClaudeJson } from './denylist.js';
import { readJsonOrUndefined } from './files.js';
import {
  compareStrings,
  isArray,
  isRecord,
  type JsonRecord,
  setOwn,
  stringRecord,
} from './json.js';
import { looksLikeSecret, placeholderFor, scanForSecrets } from './secrets.js';

export interface McpServer {
  readonly name: string;
  readonly config: JsonRecord;
}

export function mcpServersFrom(value: unknown): readonly McpServer[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.keys(value)
    .toSorted(compareStrings)
    .flatMap((name) => {
      const config = value[name];
      return isRecord(config) ? [{ name, config }] : [];
    });
}

/** User scope servers: the mcpServers key of ~/.claude.json and nothing else. */
export async function readUserMcpServers(paths: ClaudePaths): Promise<readonly McpServer[]> {
  const allowed = pickAllowedClaudeJson(await readJsonOrUndefined(paths.claudeJson));
  return mcpServersFrom(allowed['mcpServers']);
}

/** Servers in a JSON file shaped like .mcp.json or the repo's mcp.json. */
export async function readMcpFile(file: string): Promise<readonly McpServer[]> {
  const value = await readJsonOrUndefined(file);
  return isRecord(value) ? mcpServersFrom(value['mcpServers']) : [];
}

export async function readProjectMcpServers(workspace: string): Promise<readonly McpServer[]> {
  return readMcpFile(path.join(workspace, '.mcp.json'));
}

function argsOf(config: JsonRecord): readonly string[] {
  const args = config['args'];
  return isArray(args)
    ? args.filter((argument): argument is string => typeof argument === 'string')
    : [];
}

export function serverHasSecrets(config: JsonRecord): boolean {
  const pairs = [
    ...Object.entries(stringRecord(config['env'])),
    ...Object.entries(stringRecord(config['headers'])),
  ];
  const inPairs = pairs.some(([key, value]) => looksLikeSecret(key, value));
  return inPairs || argsOf(config).some((argument) => scanForSecrets(argument).length > 0);
}

export function secretNameFor(server: string, key: string): string {
  return `MCP_${server}_${key}`.toUpperCase().replaceAll(/[^A-Z\d_]/gu, '_');
}

interface ExtractedSecret {
  readonly name: string;
  readonly value: string;
}

export interface ExtractResult {
  /** Server configs with every secret value replaced by a placeholder. */
  readonly servers: Readonly<Record<string, JsonRecord>>;
  readonly secrets: readonly ExtractedSecret[];
}

function extractPairs(
  server: string,
  value: unknown,
  secrets: ExtractedSecret[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, unknown> = { ...value };
  for (const [key, text] of Object.entries(stringRecord(value))) {
    if (looksLikeSecret(key, text)) {
      const name = secretNameFor(server, key);
      secrets.push({ name, value: text });
      setOwn(out, key, placeholderFor(name));
    }
  }
  return out;
}

function extractArgs(server: string, config: JsonRecord, secrets: ExtractedSecret[]): unknown {
  const args = config['args'];
  if (!isArray(args)) {
    return args;
  }
  return args.map((argument: unknown, index) => {
    if (typeof argument !== 'string' || scanForSecrets(argument).length === 0) {
      return argument;
    }
    const name = secretNameFor(server, `ARG_${String(index)}`);
    secrets.push({ name, value: argument });
    return placeholderFor(name);
  });
}

/** Move secret values out of server configs so the configs can be committed. */
export function extractMcpSecrets(servers: readonly McpServer[]): ExtractResult {
  const secrets: ExtractedSecret[] = [];
  const out: Record<string, JsonRecord> = {};
  for (const { name, config } of servers) {
    const next: Record<string, unknown> = { ...config };
    for (const field of ['env', 'headers']) {
      const replaced = extractPairs(name, config[field], secrets);
      if (replaced !== undefined) {
        next[field] = replaced;
      }
    }
    if ('args' in config) {
      next['args'] = extractArgs(name, config, secrets);
    }
    setOwn(out, name, next);
  }
  return { servers: out, secrets };
}
