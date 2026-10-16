// Temp homes, fake exec and model builders for the app tests. Nothing here
// touches the real ~/.claude or starts a real Claude session.

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { onTestFinished } from 'vitest';

import { fakeQueries, type FakeQueries } from '../../../../test/fake-claude/fake-query.js';
import type {
  AgentNode,
  PermissionRequest,
  SessionSummary,
  ToolCall,
} from '../../../shared/model.js';
import { ZERO_USAGE } from '../../../shared/model.js';
import { EventBus } from '../../bus.js';
import { resolveClaudePaths, type ClaudePaths } from '../../paths.js';
import type { Scheduler } from '../../store/store.js';
import type { Exec, ExecOptions, ExecResult } from '../../sync/exec.js';
import { bareRemoteWith, git } from '../../sync/test-helpers/fixtures.js';
import type { AppDeps } from '../app.js';
import { OverlordApp } from '../app.js';
import type { OverlordSettings } from '../host-port.js';
import type { ClaudeCli } from '../runtime.js';

import { FakeHost } from './fake-host.js';

export const NOW = 1_800_000_000_000;

function noCancel(): void {
  // The callback already ran, so there is nothing to cancel.
}

/** Runs store notifications at once, so tests see changes synchronously. */
export const immediateScheduler: Scheduler = (callback) => {
  callback();
  return noCancel;
};

/** Parsed JSON from a file, kept unknown so tests compare it with toStrictEqual. */
export async function readJson(file: string): Promise<unknown> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  return value;
}

/** Strings in code unit order. */
export function sorted(values: readonly string[]): string[] {
  return values.toSorted((left, right) => left.localeCompare(right));
}

export interface ExecCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ExecOptions;
}

export type Responder = (call: ExecCall) => ExecResult | undefined;

const FAIL: ExecResult = { code: 1, stdout: '', stderr: 'fake failure' };

export function ok(stdout = ''): ExecResult {
  return { code: 0, stdout, stderr: '' };
}

/** An Exec that records calls. Each responder may answer; the first answer wins, else FAIL. */
export function recordingExec(...responders: Responder[]): { exec: Exec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: Exec = async (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    await Promise.resolve();
    for (const responder of responders) {
      const answer = responder(call);
      if (answer !== undefined) {
        return answer;
      }
    }
    return FAIL;
  };
  return { exec, calls };
}

export async function writeText(file: string, text: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

export async function writeJson(file: string, value: unknown): Promise<string> {
  return writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export interface TestEnv {
  readonly root: string;
  readonly home: string;
  readonly storageDir: string;
  readonly paths: ClaudePaths;
  readonly host: FakeHost;
}

export interface EnvOptions {
  readonly workspace?: boolean;
  readonly settings?: Partial<OverlordSettings>;
}

/** A fresh temp home and storage folder, removed when the test ends. */
export async function makeEnv(options: EnvOptions = {}): Promise<TestEnv> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overlord-app-')));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  const storageDir = path.join(root, 'storage');
  await mkdir(home, { recursive: true });
  const workspace = options.workspace === true ? path.join(root, 'work') : null;
  if (workspace !== null) {
    await mkdir(workspace, { recursive: true });
  }
  const base = resolveClaudePaths({ home, platform: 'linux', env: {} });
  const paths: ClaudePaths = { ...base, managedDir: path.join(home, 'managed'), desktopDir: null };
  await mkdir(paths.configDir, { recursive: true });
  const host = new FakeHost({
    storageDir,
    workspace,
    extensionPath: path.join(root, 'ext'),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  });
  return { root, home, storageDir, paths, host };
}

/** A short socket path, since macOS limits unix socket paths to about 100 bytes. */
export function shortSocketPath(): string {
  const file = path.join('/tmp', `ov-${randomUUID().slice(0, 8)}.sock`);
  onTestFinished(async () => {
    await rm(file, { force: true });
  });
  return file;
}

export interface TestApp {
  readonly app: OverlordApp;
  readonly env: TestEnv;
  readonly bus: EventBus;
  readonly calls: ExecCall[];
  readonly kills: { readonly pid: number; readonly signal: NodeJS.Signals }[];
  readonly intervals: { readonly callback: () => void; readonly ms: number; stopped: boolean }[];
  readonly watches: { readonly file: string; readonly onChange: () => void; stopped: boolean }[];
  readonly queries: FakeQueries;
}

export interface AppOptions {
  readonly deps?: Partial<AppDeps>;
  readonly responders?: readonly Responder[];
  readonly queries?: FakeQueries;
}

// The fleet polls `claude agents --json --all`; an empty list keeps that quiet unless a test answers first.
const noJobs: Responder = (call) =>
  call.args[0] === 'agents' && call.args.includes('--all') ? ok('[]') : undefined;

export function makeApp(env: TestEnv, options: AppOptions = {}): TestApp {
  const bus = new EventBus();
  const { exec, calls } = recordingExec(...(options.responders ?? []), noJobs);
  const kills: TestApp['kills'] = [];
  const intervals: TestApp['intervals'] = [];
  const watches: TestApp['watches'] = [];
  const queries = options.queries ?? fakeQueries();
  const app = new OverlordApp({
    host: env.host,
    paths: env.paths,
    bus,
    clock: (): number => NOW,
    exec,
    isAlive: (): boolean => false,
    kill: (pid, signal): void => {
      kills.push({ pid, signal });
    },
    queryFunction: queries.queryFunction,
    planUsageFunction: async (): Promise<unknown> => {
      await Promise.resolve();
      return null;
    },
    env: {},
    hostname: 'test-host',
    platform: 'linux',
    hookSocketPath: shortSocketPath(),
    scheduler: immediateScheduler,
    interval: (callback, ms): (() => void) => {
      const entry = { callback, ms, stopped: false };
      intervals.push(entry);
      return (): void => {
        entry.stopped = true;
      };
    },
    fileWatch: (file, onChange): (() => void) => {
      const entry = { file, onChange, stopped: false };
      watches.push(entry);
      return (): void => {
        entry.stopped = true;
      };
    },
    watchFactory: null,
    claudeCli: async (): Promise<ClaudeCli> => {
      await Promise.resolve();
      return { bin: 'claude', env: {} };
    },
    ...options.deps,
  });
  onTestFinished(async () => {
    await app.dispose();
  });
  return { app, env, bus, calls, kills, intervals, watches, queries };
}

export function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    surface: 'cli',
    title: `title ${id}`,
    cwd: '/work',
    state: 'running',
    startedAt: NOW - 1000,
    updatedAt: NOW,
    usage: ZERO_USAGE,
    costUsd: null,
    model: null,
    effort: null,
    permissionMode: null,
    pid: null,
    transcriptPath: null,
    gitBranch: null,
    version: null,
    agentCount: 0,
    contextFill: null,
    recap: null,
    lastPrompt: null,
    lastPromptAt: null,
    ...overrides,
  };
}

export function agent(
  sessionId: string,
  id: string,
  overrides: Partial<AgentNode> = {},
): AgentNode {
  return {
    id,
    sessionId,
    parentAgentId: id === sessionId ? null : sessionId,
    parentToolUseId: null,
    agentType: 'general-purpose',
    description: '',
    spawnDepth: id === sessionId ? 0 : 1,
    background: false,
    state: 'running',
    startedAt: NOW - 500,
    endedAt: null,
    transcriptPath: null,
    usage: ZERO_USAGE,
    toolCallCount: 0,
    currentTool: null,
    model: null,
    ...overrides,
  };
}

export function toolCall(sessionId: string, agentId: string, id: string, input: unknown): ToolCall {
  return {
    id,
    sessionId,
    agentId,
    name: 'Read',
    input,
    startedAt: NOW - 100,
    endedAt: null,
    ok: null,
    resultPreview: null,
  };
}

export function permissionRequest(
  id: string,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    id,
    sessionId: 's1',
    agentId: 's1',
    toolName: 'Bash',
    input: { command: 'ls' },
    requestedAt: NOW,
    source: 'sdk',
    ...overrides,
  };
}

/** Lets pending promises and timers of zero delay run. */
export async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Waits until the check passes, or fails the test after `ms`. */
export async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) {
      throw new Error('timed out waiting');
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

const DEFAULT_REPO_FILES: Readonly<Record<string, string>> = {
  'overlord.json': '{"version":1}\n',
};

/** A clone of a fresh bare remote at ~/.claude-config, the default config repo path. */
export async function cloneConfigRepo(
  env: TestEnv,
  exec: Exec,
  files: Readonly<Record<string, string>> = DEFAULT_REPO_FILES,
): Promise<string> {
  const remote = await bareRemoteWith(exec, files);
  const repo = path.join(env.home, '.claude-config');
  await git(exec, env.root, ['clone', '-q', remote, repo]);
  return repo;
}
