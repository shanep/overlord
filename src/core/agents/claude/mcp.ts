// Claude Code's MCP store. The servers come from its own files: user and
// local ones from ~/.claude.json, project ones from the folder's .mcp.json,
// with the approvals Claude Code keeps for them. `claude mcp list` still runs
// for what the files cannot say: whether each server connects, the claude.ai
// connectors and the servers plugins bring. Add and remove go through
// `claude mcp add-json` and `claude mcp remove`.
// cspell:words Mcpjson

import path from 'node:path';

import type { Connector } from '../../../shared/connectors.js';
import { runMcpCommand } from '../../connectors/mcp-cli.js';
import {
  byPrecedence,
  isRecord,
  readJsonFile,
  readServerFile,
  serversIn,
  stringList,
} from '../../connectors/mcp-files.js';
import { parseMcpList } from '../../connectors/mcp-list.js';
import type { McpPlace, McpRead, McpServer, McpStore, McpWrite } from '../types.js';

/** `claude mcp list` checks every server in parallel, each with its own timeout. */
export const MCP_LIST_TIMEOUT_MS = 90_000;

interface Approvals {
  readonly all: boolean;
  readonly enabled: ReadonlySet<string>;
  readonly disabled: ReadonlySet<string>;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function approvalsFrom(records: readonly JsonRecord[]): Approvals {
  return {
    all: records.some((record) => record['enableAllProjectMcpServers'] === true),
    enabled: new Set(records.flatMap((record) => stringList(record['enabledMcpjsonServers']))),
    disabled: new Set(records.flatMap((record) => stringList(record['disabledMcpjsonServers']))),
  };
}

function projectState(approvals: Approvals): (name: string) => McpServer['state'] {
  return (name) => {
    if (approvals.disabled.has(name)) {
      return 'off';
    }
    return approvals.all || approvals.enabled.has(name) ? 'on' : 'pending';
  };
}

async function recordOf(file: string): Promise<JsonRecord | null> {
  const parsed = await readJsonFile(file);
  return 'error' in parsed || !isRecord(parsed.value) ? null : parsed.value;
}

const ON = (): McpServer['state'] => 'on';

async function read(place: McpPlace): Promise<McpRead> {
  const file = place.claude.claudeJson;
  const claudeJson = await readJsonFile(file);
  const errors = 'error' in claudeJson ? [claudeJson.error] : [];
  const top = 'error' in claudeJson || !isRecord(claudeJson.value) ? {} : claudeJson.value;
  const user = serversIn(top['mcpServers'], { scope: 'user', file, state: ON });
  if (place.cwd === null) {
    return { servers: user, errors };
  }
  const { cwd } = place;
  const projects = top['projects'];
  const entry = isRecord(projects) ? projects[cwd] : undefined;
  const project = isRecord(entry) ? entry : {};
  const local = serversIn(project['mcpServers'], { scope: 'local', file, state: ON });
  const settings = await Promise.all(
    [
      place.claude.userSettings,
      path.join(cwd, '.claude', 'settings.json'),
      path.join(cwd, '.claude', 'settings.local.json'),
    ].map(async (settingsFile) => recordOf(settingsFile)),
  );
  const approvals = approvalsFrom([
    project,
    ...settings.filter((record): record is JsonRecord => record !== null),
  ]);
  const shared = await readServerFile(path.join(cwd, '.mcp.json'), {
    scope: 'project',
    state: projectState(approvals),
  });
  return {
    servers: [...local, ...shared.servers, ...user],
    errors: shared.error === null ? errors : [...errors, shared.error],
  };
}

/** A row for a server in Claude Code's files that `claude mcp list` left out. */
function fileRow(server: McpServer, listed: boolean): Connector {
  const base = {
    id: `mcp:${server.name}`,
    name: server.name,
    kind: 'mcp' as const,
    target: server.target,
    fix: null,
  };
  if (server.state === 'pending') {
    return {
      ...base,
      status: 'pending',
      detail: 'Waiting for you to approve this project .mcp.json server in a Claude Code session.',
    };
  }
  if (server.state === 'off') {
    return { ...base, status: 'disabled', detail: 'Turned off for this project.' };
  }
  const why = listed ? 'claude mcp list did not report it' : 'claude mcp list did not run';
  return {
    ...base,
    status: 'unknown',
    detail: `Set up in ${server.file}, but ${why}.`,
  };
}

async function cliRows(input: McpWrite): Promise<Connector[] | Connector> {
  const result = await input.exec(input.cli.bin, ['mcp', 'list'], {
    cwd: input.cwd,
    env: input.cli.env,
    timeoutMs: MCP_LIST_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `claude mcp list exited ${String(result.code)}`;
    return {
      id: 'mcp:list',
      name: 'MCP servers',
      kind: 'mcp',
      target: 'claude mcp list',
      status: 'failed',
      detail: `Could not list the MCP servers: ${detail}`,
      fix: null,
    };
  }
  return parseMcpList(result.stdout);
}

/**
 * What `claude mcp list` printed, in its order, then any server the files
 * hold that it left out. When it fails, its error and every file server.
 */
async function list(input: McpWrite & { readonly place: McpPlace }): Promise<Connector[]> {
  const [rows, files] = await Promise.all([cliRows(input), read(input.place)]);
  const listed = Array.isArray(rows);
  const shown = new Set(listed ? rows.map((row) => row.name) : []);
  const extra = byPrecedence(files.servers)
    .filter((server) => !shown.has(server.name))
    .map((server) => fileRow(server, listed));
  return [...(listed ? rows : [rows]), ...extra];
}

export const claudeMcp: McpStore = {
  scopes: ['user', 'project', 'local'],
  read,
  list,
  add: async (input) =>
    runMcpCommand(
      input,
      ['mcp', 'add-json', '--scope', input.scope, input.name, JSON.stringify(input.server)],
      'claude mcp add-json',
    ),
  remove: async (input) =>
    runMcpCommand(
      input,
      ['mcp', 'remove', '--scope', input.scope, input.name],
      'claude mcp remove',
    ),
  signInArgs: (name) => ['mcp', 'login', name],
};
