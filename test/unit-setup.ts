// Runs before every node test file, including every Stryker mutant run.
//
// Mutants once dropped the fake binary path and emptied the child env, so the
// Agent SDK started the real Claude CLI with the user's login and made real API
// calls. Env settings alone cannot stop that, because the code under test
// controls the child's env. So this file blocks starting any real agent CLI
// (Claude, Codex, Copilot, Gemini, Antigravity) at the child_process level,
// and also clears their keys and points their homes at temp folders for
// anything that slips past.
// cspell:words bunx
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
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

/** Keys and logins the other agent CLIs read. Each is removed before any test runs. */
export const AGENT_SECRET_VARS: readonly string[] = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GH_TOKEN',
  'GITHUB_TOKEN',
];

/** Every variable with one of these prefixes is removed too, before the homes below are set. */
export const AGENT_VAR_PREFIXES: readonly string[] = ['CODEX_', 'COPILOT_', 'GEMINI_'];

for (const name of Object.keys(process.env)) {
  if (
    AGENT_SECRET_VARS.includes(name) ||
    AGENT_VAR_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    Reflect.deleteProperty(process.env, name);
  }
}

// Codex reads CODEX_HOME, Copilot reads COPILOT_HOME (`copilot help
// environment`), and Gemini reads GEMINI_CLI_HOME. Each would otherwise use a
// folder in the real home, where the user's login lives.
const agentHomes = mkdtempSync(path.join(os.tmpdir(), 'overlord-unit-agents-'));
function agentHome(name: string): string {
  const dir = path.join(agentHomes, name);
  mkdirSync(dir);
  return dir;
}
process.env['CODEX_HOME'] = agentHome('codex');
process.env['COPILOT_HOME'] = agentHome('copilot');
process.env['GEMINI_CLI_HOME'] = agentHome('gemini');
process.env['OPENAI_BASE_URL'] = DEAD_BASE_URL;
// Copilot skips every network call in offline mode and never updates itself.
process.env['COPILOT_OFFLINE'] = 'true';
process.env['COPILOT_AUTO_UPDATE'] = 'false';

/** The agent CLIs tests must never start, by the program name each one installs. */
export const REAL_AGENTS: readonly string[] = ['claude', 'codex', 'copilot', 'gemini', 'agy'];

/** The npm packages that ship them, which npx or npm exec would fetch and run. */
export const AGENT_PACKAGES: Readonly<Record<string, string>> = {
  '@anthropic-ai/claude-code': 'claude',
  '@openai/codex': 'codex',
  '@github/copilot': 'copilot',
  '@google/gemini-cli': 'gemini',
};

const LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  gemini: 'Gemini',
  agy: 'Antigravity',
};

/** Fake agent binaries live here and may be named like the real ones. */
const FAKE_AGENTS = '/test/fake-agents/';
const PACKAGE_RUNNERS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx', 'bun']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh']);
const SHELL_COMMAND_FLAGS = new Set(['-c', '/c', '-command', '-lc']);
/** Programs that run the command after them, like `env FOO=1 codex`. */
const WRAPPERS = new Set(['env', 'exec', 'command', 'nohup', 'time', 'sudo']);
const WINDOWS_SUFFIX = /\.(?:exe|cmd|bat|ps1)$/u;
const ASSIGNMENT = /^\w+=/u;

/** The program name a command runs, lower case and without a Windows suffix. */
function programName(normalized: string): string {
  return path.posix.basename(normalized).toLowerCase().replace(WINDOWS_SUFFIX, '');
}

/** The agent an npx argument names: `@openai/codex@1.2` or `--package=@openai/codex`. */
function packageAgent(argument: string): string | null {
  const spec = argument.replace(/^--package=/u, '');
  for (const [name, agent] of Object.entries(AGENT_PACKAGES)) {
    if (spec === name || spec.startsWith(`${name}@`)) {
      return agent;
    }
  }
  return REAL_AGENTS.includes(spec) ? spec : null;
}

/** The agent whose installed package files an argument points into, as in `node .../@openai/codex/bin/codex.js`. */
function packagePathAgent(argument: string): string | null {
  const normalized = argument.replaceAll('\\', '/');
  for (const [name, agent] of Object.entries(AGENT_PACKAGES)) {
    if (normalized.includes(`/${name}/`)) {
      return agent;
    }
  }
  return null;
}

function firstAgent(
  values: readonly string[],
  find: (value: string) => string | null,
): string | null {
  for (const value of values) {
    const agent = find(value);
    if (agent !== null) {
      return agent;
    }
  }
  return null;
}

/** The command a wrapper or shell runs: what follows `env FOO=1` or `sh -c`. */
function innerAgent(name: string, args: readonly string[]): string | null {
  if (WRAPPERS.has(name)) {
    const start = args.findIndex(
      (argument) => !argument.startsWith('-') && !ASSIGNMENT.test(argument),
    );
    const [inner, ...rest] = start === -1 ? [] : args.slice(start);
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the two recurse into each other
    return inner === undefined ? null : realAgentOf(inner, rest);
  }
  if (SHELLS.has(name)) {
    const flag = args.findIndex((argument) => SHELL_COMMAND_FLAGS.has(argument.toLowerCase()));
    const line = flag === -1 ? undefined : args[flag + 1];
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the two recurse into each other
    return line === undefined ? null : realAgentInLine(line);
  }
  return null;
}

/** The agent CLI a program and its arguments would start, or null for anything else. */
export function realAgentOf(command: string, args: readonly string[] = []): string | null {
  const normalized = command.replaceAll('\\', '/');
  if (normalized.includes(FAKE_AGENTS)) {
    return null;
  }
  const name = programName(normalized);
  if (REAL_AGENTS.includes(name)) {
    return name;
  }
  if (normalized.includes('/claude-agent-sdk-')) {
    return 'claude';
  }
  const fromPath = packagePathAgent(normalized) ?? firstAgent(args, packagePathAgent);
  if (fromPath !== null) {
    return fromPath;
  }
  if (PACKAGE_RUNNERS.has(name)) {
    return firstAgent(args, packageAgent);
  }
  return innerAgent(name, args);
}

function unquote(word: string): string {
  return word.replaceAll(/^["']|["']$/gu, '');
}

/** The agent CLI any command in a shell line would start, skipping leading `FOO=1` settings. */
export function realAgentInLine(line: string): string | null {
  for (const part of line.split(/&&|\|\||[\n;&|]/u)) {
    const words = part
      .split(/\s+/u)
      .filter((word) => word !== '')
      .map((word) => unquote(word));
    const start = words.findIndex((word) => !ASSIGNMENT.test(word));
    const [command, ...args] = start === -1 ? [] : words.slice(start);
    const agent = command === undefined ? null : realAgentOf(command, args);
    if (agent !== null) {
      return agent;
    }
  }
  return null;
}

/** True for the real Claude CLI: a binary named claude, or the SDK's bundled native one. */
export function isRealClaude(command: string): boolean {
  return realAgentOf(command) === 'claude';
}

export class RealAgentBlocked extends Error {
  readonly agent: string;

  constructor(agent: string, command: string) {
    const label = LABELS[agent] ?? agent;
    super(`Tests must never start the real ${label} CLI (${command}). Use a fake binary.`);
    this.name = 'RealAgentBlocked';
    this.agent = agent;
  }
}

export class RealClaudeBlocked extends RealAgentBlocked {
  constructor(command: string) {
    super('claude', command);
    this.name = 'RealClaudeBlocked';
  }
}

function blocked(agent: string, command: string): RealAgentBlocked {
  return agent === 'claude' ? new RealClaudeBlocked(command) : new RealAgentBlocked(agent, command);
}

const original = {
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync,
  execFile: childProcess.execFile,
  execFileSync: childProcess.execFileSync,
  exec: childProcess.exec,
  execSync: childProcess.execSync,
  fork: childProcess.fork,
};

function textOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return value instanceof URL ? value.pathname : null;
}

/** Array.isArray narrows unknown to any[], so this keeps the elements unknown. */
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function stringArgs(value: unknown): string[] {
  return isList(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** spawn, spawnSync, execFile and execFileSync: a program and an optional argument list. */
function checkProgram(args: readonly unknown[]): void {
  const command = textOf(args[0]);
  if (command === null) {
    return;
  }
  const rest = stringArgs(args[1]);
  // With `shell: true` the program can be a whole command line.
  const agent =
    realAgentOf(command, rest) ??
    (/\s/u.test(command) ? realAgentInLine([command, ...rest].join(' ')) : null);
  if (agent !== null) {
    throw blocked(agent, [command, ...rest].join(' '));
  }
}

/** exec and execSync: one shell command line. */
function checkLine(args: readonly unknown[]): void {
  const line = textOf(args[0]);
  const agent = line === null ? null : realAgentInLine(line);
  if (agent !== null && line !== null) {
    throw blocked(agent, line.trim());
  }
}

/** fork: a module that node runs. */
function checkModule(args: readonly unknown[]): void {
  const file = textOf(args[0]);
  if (file === null) {
    return;
  }
  const agent = realAgentOf('node', [file, ...stringArgs(args[1])]);
  if (agent !== null) {
    throw blocked(agent, file);
  }
}

// Checks the program, then calls the real function with the same arguments.
// The overloads differ, so the arguments are forwarded untouched.
function guarded<T extends (...args: never[]) => unknown>(
  real: T,
  check: (args: readonly unknown[]) => void,
): T {
  return new Proxy(real, {
    apply(target, thisArgument: unknown, args: unknown[]): unknown {
      check(args);
      return Reflect.apply(target, thisArgument, args);
    },
  });
}

childProcess.spawn = guarded(original.spawn, checkProgram);
childProcess.spawnSync = guarded(original.spawnSync, checkProgram);
childProcess.execFile = guarded(original.execFile, checkProgram);
childProcess.execFileSync = guarded(original.execFileSync, checkProgram);
childProcess.exec = guarded(original.exec, checkLine);
childProcess.execSync = guarded(original.execSync, checkLine);
childProcess.fork = guarded(original.fork, checkModule);
// Make `import { spawn } from 'node:child_process'` see the wrapped versions too.
syncBuiltinESMExports();
