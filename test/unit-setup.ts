// Runs before every node test file, including every Stryker mutant run.
//
// Mutants once dropped the fake binary path and emptied the child env, so the
// Agent SDK started the real Claude CLI with the user's login and made real API
// calls. Env settings alone cannot stop that, because the code under test
// controls the child's env. So this file blocks starting any real claude
// binary at the child_process level, and also sets a dead API endpoint for
// anything that slips past.
import childProcess from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export const DEAD_BASE_URL = 'http://127.0.0.1:9';

// Git sets these while it runs a hook (pre-push runs the tests), and in a
// worktree they hold absolute paths. A test that starts git would then act on
// this repo instead of its own temp repo: one turned core.bare on. Tests make
// their own repos, so none of these should ever reach them.
export const REPO_GIT_VARS: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
];
for (const name of REPO_GIT_VARS) {
  Reflect.deleteProperty(process.env, name);
}

process.env['ANTHROPIC_BASE_URL'] = DEAD_BASE_URL;
process.env['ANTHROPIC_API_KEY'] = 'overlord-test-no-key';
process.env['CLAUDE_CODE_MAX_RETRIES'] = '0';
process.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1';
process.env['CLAUDE_CONFIG_DIR'] = mkdtempSync(path.join(os.tmpdir(), 'overlord-unit-claude-'));
delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];

/** True for the real Claude CLI: a binary named claude, or the SDK's bundled native one. */
export function isRealClaude(command: string): boolean {
  const normalized = command.replaceAll('\\', '/');
  const base = path.posix.basename(normalized).toLowerCase();
  return (
    base === 'claude' ||
    base === 'claude.exe' ||
    base === 'claude.cmd' ||
    normalized.includes('/claude-agent-sdk-')
  );
}

export class RealClaudeBlocked extends Error {
  constructor(command: string) {
    super(`Tests must never start the real Claude CLI (${command}). Use the fake binary.`);
    this.name = 'RealClaudeBlocked';
  }
}

function firstWord(commandLine: string): string {
  return commandLine.trim().split(/\s+/u, 1)[0] ?? '';
}

function check(command: unknown): void {
  if (typeof command === 'string' && isRealClaude(command)) {
    throw new RealClaudeBlocked(command);
  }
}

const original = {
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync,
  execFile: childProcess.execFile,
  execFileSync: childProcess.execFileSync,
  exec: childProcess.exec,
  execSync: childProcess.execSync,
};

function commandOf(args: readonly unknown[]): unknown {
  return args[0];
}

function shellCommandOf(args: readonly unknown[]): unknown {
  return typeof args[0] === 'string' ? firstWord(args[0]) : args[0];
}

// Checks the program, then calls the real function with the same arguments.
// The overloads differ, so the arguments are forwarded untouched.
function guarded<T extends (...args: never[]) => unknown>(
  real: T,
  pick: (args: readonly unknown[]) => unknown,
): T {
  return new Proxy(real, {
    apply(target, thisArgument: unknown, args: unknown[]): unknown {
      check(pick(args));
      return Reflect.apply(target, thisArgument, args);
    },
  });
}

childProcess.spawn = guarded(original.spawn, commandOf);
childProcess.spawnSync = guarded(original.spawnSync, commandOf);
childProcess.execFile = guarded(original.execFile, commandOf);
childProcess.execFileSync = guarded(original.execFileSync, commandOf);
childProcess.exec = guarded(original.exec, shellCommandOf);
childProcess.execSync = guarded(original.execSync, shellCommandOf);
// Make `import { spawn } from 'node:child_process'` see the wrapped versions too.
syncBuiltinESMExports();
