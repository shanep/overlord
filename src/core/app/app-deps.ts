// What OverlordApp takes from outside, and the real defaults for each piece
// a test leaves out.

import os from 'node:os';

import { EventBus } from '../bus.js';
import type { StdioToolCaller } from '../connectors/stdio-mcp.js';
import { createNodeFileSystem, type FileSystem } from '../context/fs.js';
import type { PlanUsageFunction, QueryFunction } from '../harness/sdk-types.js';
import { defaultClaudePaths, type ClaudePaths } from '../paths.js';
import type { Scheduler } from '../store/store.js';
import { makeIsAlive, type IsAlive } from '../surfaces/process.js';
import { createNodeExec, type Exec } from '../sync/exec.js';
import type { FetchFunction } from '../sync/github.js';
import type { WatchFactory } from '../transcripts/watcher.js';

import type { HostPort } from './host-port.js';
import type { FileWatchFunction, IntervalFunction, KillFunction } from './process.js';
import { defaultInterval, defaultKill, pollingFileWatch } from './process.js';
import type { ClaudeCli } from './runtime.js';

const SETTINGS_POLL_MS = 2000;

export interface AppDeps {
  readonly host: HostPort;
  readonly paths?: ClaudePaths;
  readonly bus?: EventBus;
  readonly clock?: () => number;
  /** Runs git and claude. Defaults to child_process.execFile with no shell. */
  readonly exec?: Exec;
  readonly isAlive?: IsAlive;
  readonly kill?: KillFunction;
  /** The Agent SDK query. Tests pass a fake so no real Claude session ever starts. */
  readonly queryFunction?: QueryFunction;
  /** Reads plan limits through the SDK. Tests pass a fake for the same reason. */
  readonly planUsageFunction?: PlanUsageFunction;
  readonly fs?: FileSystem;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly hostname?: string;
  readonly platform?: NodeJS.Platform;
  readonly hookSocketPath?: string;
  /** For the store's change notifications. */
  readonly scheduler?: Scheduler;
  readonly interval?: IntervalFunction;
  readonly delay?: (ms: number) => Promise<void>;
  readonly fileWatch?: FileWatchFunction;
  /** Null turns the transcript watcher's fs.watch off and leaves its poll. */
  readonly watchFactory?: WatchFactory | null;
  /** This process's id, which marks the worktrees it holds. */
  readonly pid?: number;
  /** Where claude runs from outside a terminal. Tests pass a fake so no login shell starts. */
  readonly claudeCli?: () => Promise<ClaudeCli>;
  /** Calls the GitHub REST API and the MCP registry. Defaults to the global fetch. */
  readonly fetch?: FetchFunction;
  /** Calls a tool on a stdio MCP server. Tests pass a fake so no Chrome server starts. */
  readonly callTool?: StdioToolCaller;
}

export interface CoreDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: () => number;
  readonly exec: Exec;
  readonly platform: NodeJS.Platform;
  readonly paths: ClaudePaths;
  readonly bus: EventBus;
}

export interface MachineDeps {
  readonly isAlive: IsAlive;
  readonly kill: KillFunction;
  readonly hostname: string;
  readonly fs: FileSystem;
  readonly interval: IntervalFunction;
  readonly delay: (ms: number) => Promise<void>;
  readonly fileWatch: FileWatchFunction;
  readonly fetch: FetchFunction;
}

export function coreDeps(deps: AppDeps): CoreDeps {
  return {
    env: deps.env ?? process.env,
    clock: deps.clock ?? Date.now,
    exec: deps.exec ?? createNodeExec(),
    platform: deps.platform ?? process.platform,
    paths: deps.paths ?? defaultClaudePaths(),
    bus: deps.bus ?? new EventBus(),
  };
}

export async function defaultDelay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function machineDeps(deps: AppDeps): MachineDeps {
  return {
    isAlive: deps.isAlive ?? makeIsAlive(),
    kill: deps.kill ?? defaultKill,
    hostname: deps.hostname ?? os.hostname(),
    fs: deps.fs ?? createNodeFileSystem(),
    interval: deps.interval ?? defaultInterval,
    delay: deps.delay ?? defaultDelay,
    fileWatch: deps.fileWatch ?? pollingFileWatch(SETTINGS_POLL_MS),
    fetch: deps.fetch ?? fetch,
  };
}
