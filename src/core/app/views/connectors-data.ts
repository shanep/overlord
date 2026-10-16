// What the connectors cache holds, and the loader behind it. It takes its
// inputs one by one rather than the runtime, which holds this cache.

import type { ConnectorsState } from '../../../shared/connectors.js';
import { checkConnectors } from '../../connectors/check.js';
import type { StdioToolCaller } from '../../connectors/stdio-mcp.js';
import type { Exec } from '../../sync/exec.js';

export type ConnectorsData = Omit<ConnectorsState, 'checking'>;

export const EMPTY_CONNECTORS: ConnectorsData = { connectors: [], checkedAt: null, folder: null };

export interface ConnectorsLoad {
  readonly claudeCli: () => Promise<{
    readonly bin: string;
    readonly env: Readonly<Record<string, string>>;
  }>;
  /** Where `claude mcp list` runs, or null for the home folder. */
  readonly workspace: string | null;
  readonly home: string;
  readonly claudeJson: string;
  readonly platform: NodeJS.Platform;
  readonly exec: Exec;
  readonly callTool: StdioToolCaller;
  readonly clock: () => number;
}

export async function loadConnectors(load: ConnectorsLoad): Promise<ConnectorsData> {
  const cli = await load.claudeCli();
  const connectors = await checkConnectors({
    bin: cli.bin,
    env: cli.env,
    cwd: load.workspace ?? load.home,
    home: load.home,
    claudeJson: load.claudeJson,
    platform: load.platform,
    exec: load.exec,
    callTool: load.callTool,
  });
  return { connectors, checkedAt: load.clock(), folder: load.workspace };
}
