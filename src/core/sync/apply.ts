// Runs a plan. Every backup in the plan happens first, into
// ~/.claude/backups/overlord-<timestamp>/ (another agent's files go in a
// folder named for the agent inside it), and nothing that exists is ever
// overwritten or removed unless it was backed up in this run (symlinks are
// the exception: removing a link leaves the data it points at alone).

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CLAUDE_CODE, type AgentId } from '../../shared/agents.js';
import type { AgentCli, McpStore } from '../agents/types.js';
import type { ClaudePaths } from '../paths.js';

import { isAgentStep, type Action, type AgentStep } from './actions.js';
import { serverConfigFor } from './agent-mcp.js';
import { setSettingKeys } from './agent-settings.js';
import type { Exec } from './exec.js';
import { copyPath, isInside, lstatOrNull, pathExists } from './files.js';
import { clone } from './git.js';
import { resolveSecrets, resolveSecretsInText, type SecretStore } from './secrets.js';

/** An agent's MCP store and the binary its add and remove run. */
export interface AgentMcp {
  readonly store: McpStore;
  readonly cli: AgentCli;
}

export interface ApplyDeps {
  readonly exec: Exec;
  readonly secrets: SecretStore;
  readonly paths: ClaudePaths;
  readonly now: () => Date;
  /** Symlinks become copies on Windows, where links need extra rights. */
  readonly platform: NodeJS.Platform;
  /** The MCP store for an agent. Throws when the agent has none or is not installed. */
  readonly mcp?: (agent: AgentId) => Promise<AgentMcp>;
}

export interface ApplyResult {
  /** Where this run's backups went, or null when nothing needed one. */
  readonly backupDir: string | null;
  readonly performed: readonly Action[];
  readonly failed: { readonly action: Action; readonly message: string } | null;
}

const COMMAND_TIMEOUT_MS = 300_000;

export function backupDirName(now: Date): string {
  return `overlord-${now.toISOString().replaceAll(':', '-').replace('.', '-')}`;
}

/**
 * Where a path lands inside a backup folder: relative to home, or under
 * _root/ when outside it. Another agent's files go under a folder named for
 * the agent, so Claude Code's backups stay where they always were.
 */
export function backupLocation(
  backupDir: string,
  target: string,
  home: string,
  agent: AgentId = CLAUDE_CODE,
): string {
  const dir = agent === CLAUDE_CODE ? backupDir : path.join(backupDir, agent);
  const resolved = path.resolve(target);
  if (isInside(resolved, home) && resolved !== path.resolve(home)) {
    return path.join(dir, path.relative(home, resolved));
  }
  return path.join(dir, '_root', path.relative(path.parse(resolved).root, resolved));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Failure = ApplyResult['failed'];

interface BackupTarget {
  readonly path: string;
  readonly agent: AgentId;
}

interface BackupOutcome {
  readonly dir: string | null;
  readonly failed: Failure;
}

class Runner {
  readonly backedUp = new Set<string>();
  readonly deps: ApplyDeps;

  constructor(deps: ApplyDeps) {
    this.deps = deps;
  }

  /** Clear the way for a new file at `target`. */
  async clear(target: string): Promise<void> {
    const info = await lstatOrNull(target);
    if (info === null) {
      return;
    }
    if (!info.isSymbolicLink() && !this.backedUp.has(path.resolve(target))) {
      throw new Error(`Refusing to replace ${target}: it was not backed up first`);
    }
    await rm(target, { recursive: true, force: true });
  }

  async place(target: string, write: () => Promise<void>): Promise<void> {
    await this.clear(target);
    await mkdir(path.dirname(target), { recursive: true });
    await write();
  }

  async runCommand(command: string, args: readonly string[]): Promise<void> {
    const filled: string[] = [];
    const missing: string[] = [];
    for (const part of args) {
      const resolved = await resolveSecretsInText(part, this.deps.secrets);
      filled.push(resolved.text);
      missing.push(...resolved.missing);
    }
    if (missing.length > 0) {
      throw new Error(`Missing secrets: ${missing.join(', ')}`);
    }
    const result = await this.deps.exec(command, filled, { timeoutMs: COMMAND_TIMEOUT_MS });
    if (result.code !== 0) {
      throw new Error(`${command} exited ${String(result.code)}: ${result.stderr.trim()}`);
    }
  }

  async link(source: string, target: string): Promise<void> {
    const windows = this.deps.platform === 'win32';
    await this.place(target, async () =>
      windows ? copyPath(source, target) : symlink(source, target),
    );
  }

  async mcpFor(agent: AgentId): Promise<AgentMcp> {
    if (this.deps.mcp === undefined) {
      throw new Error(`Overlord cannot reach ${agent}'s MCP servers here`);
    }
    return this.deps.mcp(agent);
  }

  async mcpAdd(action: Extract<Action, { kind: 'mcp-add' }>): Promise<void> {
    const resolved = await resolveSecrets(action.config, this.deps.secrets);
    if (resolved.missing.length > 0) {
      throw new Error(`Missing secrets: ${resolved.missing.join(', ')}`);
    }
    const server = serverConfigFor(resolved.value);
    if (server === null) {
      throw new Error(`${action.name} has neither a command nor a URL`);
    }
    const { store, cli } = await this.mcpFor(action.agent);
    const result = await store.add({
      exec: this.deps.exec,
      cli,
      cwd: this.deps.paths.home,
      name: action.name,
      server,
      scope: 'user',
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
  }

  async mcpRemove(agent: AgentId, name: string): Promise<void> {
    const { store, cli } = await this.mcpFor(agent);
    const result = await store.remove({
      exec: this.deps.exec,
      cli,
      cwd: this.deps.paths.home,
      name,
      scope: 'user',
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
  }

  async setKeys(action: Extract<Action, { kind: 'set-keys' }>): Promise<void> {
    if ((await pathExists(action.target)) && !this.backedUp.has(path.resolve(action.target))) {
      throw new Error(`Refusing to change ${action.target}: it was not backed up first`);
    }
    const failed = await setSettingKeys(action.target, action.format, action.entries);
    if (failed.length > 0) {
      throw new Error(`Could not set ${failed.join('; ')}`);
    }
  }

  async cloneExternal(repoUrl: string, destination: string): Promise<void> {
    if (await pathExists(destination)) {
      return;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await clone(this.deps.exec, repoUrl, destination);
  }

  async agentStep(action: AgentStep): Promise<void> {
    switch (action.kind) {
      case 'set-keys': {
        await this.setKeys(action);
        return;
      }
      case 'mcp-add': {
        await this.mcpAdd(action);
        return;
      }
      case 'mcp-remove': {
        await this.mcpRemove(action.agent, action.name);
        return;
      }
      case 'save-secret': {
        await this.deps.secrets.set(action.name, action.value);
        return;
      }
    }
  }

  async perform(action: Action): Promise<void> {
    if (isAgentStep(action)) {
      await this.agentStep(action);
      return;
    }
    switch (action.kind) {
      case 'mkdir': {
        await mkdir(action.path, { recursive: true });
        return;
      }
      case 'link': {
        await this.link(action.source, action.target);
        return;
      }
      case 'copy': {
        await this.place(action.target, async () => copyPath(action.source, action.target));
        return;
      }
      case 'generate-settings':
      case 'write-file': {
        await this.place(action.target, async () => writeFile(action.target, action.content));
        return;
      }
      case 'remove': {
        await this.clear(action.path);
        return;
      }
      case 'run-command': {
        await this.runCommand(action.command, action.args);
        return;
      }
      case 'clone-external': {
        await this.cloneExternal(action.repoUrl, action.destination);
        return;
      }
      case 'backup':
      case 'note': {
        return;
      }
    }
  }

  /** Copy every existing target into one backup folder. Stops at the first copy that fails. */
  async backup(targets: readonly BackupTarget[]): Promise<BackupOutcome> {
    const existing: BackupTarget[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const resolved = path.resolve(target.path);
      if (!seen.has(resolved) && (await pathExists(resolved))) {
        seen.add(resolved);
        existing.push({ path: resolved, agent: target.agent });
      }
    }
    if (existing.length === 0) {
      return { dir: null, failed: null };
    }
    const { paths } = this.deps;
    const dir = path.join(paths.configDir, 'backups', backupDirName(this.deps.now()));
    for (const target of existing) {
      const destination = backupLocation(dir, target.path, paths.home, target.agent);
      try {
        await mkdir(path.dirname(destination), { recursive: true });
        await copyPath(target.path, destination);
      } catch (error: unknown) {
        return {
          dir,
          failed: { action: { kind: 'backup', path: target.path }, message: messageOf(error) },
        };
      }
      this.backedUp.add(target.path);
    }
    return { dir, failed: null };
  }
}

/** Back up, then perform each action in order, stopping at the first failure. */
export async function applyPlan(actions: readonly Action[], deps: ApplyDeps): Promise<ApplyResult> {
  const runner = new Runner(deps);
  const backups = actions.flatMap((action) =>
    action.kind === 'backup' ? [{ path: action.path, agent: action.agent ?? CLAUDE_CODE }] : [],
  );
  const { dir: backupDir, failed } = await runner.backup(backups);
  if (failed !== null) {
    return { backupDir, performed: [], failed };
  }
  const performed: Action[] = [];
  for (const action of actions) {
    try {
      await runner.perform(action);
    } catch (error: unknown) {
      return { backupDir, performed, failed: { action, message: messageOf(error) } };
    }
    if (action.kind !== 'note') {
      performed.push(action);
    }
  }
  return { backupDir, performed, failed: null };
}
