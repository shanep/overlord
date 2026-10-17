// What config sync keeps for Copilot CLI under agents/copilot/ in the config
// repo: its global instructions, skills and agent files, the settings in
// settings.json key by key, and the user MCP servers in mcp-config.json.
// config.json, where Copilot keeps the signed in accounts, never syncs.

import path from 'node:path';

import { isRecord, readJsonFile } from '../../connectors/mcp-files.js';
import type { SyncedMcpServer, SyncFacet } from '../sync-types.js';

import { copilotHome } from './mcp.js';

// Settings that name this machine's folders or the accounts signed in here.
const LOCAL_KEYS: ReadonlySet<string> = new Set([
  'trusted_folders',
  'trustedFolders',
  'logged_in_users',
  'loggedInUsers',
  'last_logged_in_user',
  'lastLoggedInUser',
  'firstLaunchAt',
]);

async function readServers(dir: string): Promise<readonly SyncedMcpServer[] | null> {
  const file = await readJsonFile(path.join(dir, 'mcp-config.json'), true);
  if ('error' in file) {
    return null;
  }
  const servers = isRecord(file.value) ? file.value['mcpServers'] : undefined;
  if (!isRecord(servers)) {
    return [];
  }
  return Object.entries(servers).flatMap(([name, config]) =>
    isRecord(config) ? [{ name, config }] : [],
  );
}

export const copilotSync: SyncFacet = {
  dir: copilotHome,
  files: [{ kind: 'claude-md', file: 'copilot-instructions.md' }],
  folders: [
    { kind: 'skill', dir: 'skills', entries: 'dirs' },
    { kind: 'agent', dir: 'agents', entries: { suffix: '.md' } },
  ],
  settings: {
    file: 'settings.json',
    format: 'json',
    repoName: 'settings.json',
    local: (keyPath) => LOCAL_KEYS.has(keyPath[0] ?? ''),
  },
  mcp: { file: 'mcp-config.json', read: readServers },
};
