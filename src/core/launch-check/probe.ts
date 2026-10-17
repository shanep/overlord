// Looks at a repository the way a session landing in one of its worktrees
// needs to: how work lands there and whether the instructions agree on it,
// what checks a commit or push, whether heavy commands take turns, whether
// the app's ports clash between sessions, and what memory and stray worktrees
// come along. Every probe runs git, gh or a file read in the background, so
// the hook reply never waits on one, and a probe that fails adds nothing.

import path from 'node:path';

import { z } from 'zod';

import type { Exec } from '../sync/exec.js';
import { NOT_FOUND_CODE } from '../sync/exec.js';

import type { Finding, InstructionDeps } from './instructions.js';
import {
  info,
  landingFindings,
  listed,
  memoryFindings,
  repoInstructions,
  shownPath,
  warn,
} from './instructions.js';

export type { Finding, FindingLevel } from './instructions.js';

export interface LaunchCheck {
  readonly repoRoot: string;
  readonly checkedAt: number;
  readonly findings: readonly Finding[];
}

export interface ProbeTarget {
  readonly repoRoot: string;
  /** The origin branch work lands on, or null when the repository has no origin. */
  readonly target: string | null;
}

export interface ProbeDeps extends InstructionDeps {
  readonly exec: Exec;
  /** Where Overlord makes worktrees, so the ones it made are not called strays. */
  readonly worktreeRoot: string;
  readonly now: () => number;
}

const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 15_000;
const FIXED_PORT = /(?:localhost|127\.0\.0\.1):(\d{4,5})\b/gu;
// The same pattern for git grep, whose extended regexps have no (?:).
const FIXED_PORT_ERE = '(localhost|127[.]0[.]0[.]1):[0-9]{4,5}';
// Config files that pin the ports an app listens on. Docs and tests are left out.
const PORT_FILES = [
  'launchSettings.json',
  'vite.config.*',
  'package.json',
  'docker-compose*.y*ml',
  'compose.y*ml',
  'appsettings*.json',
  '.env*',
  'playwright.config.*',
  'webpack.config.*',
].map((name) => `:(glob)**/${name}`);

// The file that shows a repository builds with a tool, and the tool's shim name.
const BUILD_MARKERS: readonly (readonly [RegExp, string])[] = [
  [/^package\.json$/u, 'npm'],
  [/\.(?:sln|slnx|csproj|fsproj)$/u, 'dotnet'],
  [/^Cargo\.toml$/u, 'cargo'],
  [/^go\.mod$/u, 'go'],
  [/^(?:pyproject\.toml|setup\.py|pytest\.ini)$/u, 'pytest'],
  [/^(?:Makefile|GNUmakefile)$/u, 'make'],
  [/^pom\.xml$/u, 'mvn'],
  [/^build\.gradle(?:\.kts)?$/u, 'gradle'],
  [/^CMakeLists\.txt$/u, 'cmake'],
];
const MARKER_DEPTH = 3;
const HOOK_MANAGERS = [
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.husky',
  '.pre-commit-config.yaml',
];
const LANDING_HOOKS = new Set(['pre-commit', 'pre-push', 'commit-msg', 'pre-merge-commit']);

const branchSchema = z.object({
  protected: z.boolean(),
  protection: z
    .object({
      required_status_checks: z
        .object({ enforcement_level: z.string(), contexts: z.array(z.string()) })
        .optional(),
    })
    .optional(),
});

type Branch = z.infer<typeof branchSchema>;

async function git(
  deps: ProbeDeps,
  repoRoot: string,
  args: readonly string[],
): Promise<string | null> {
  const result = await deps.exec('git', ['-C', repoRoot, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  return result.code === 0 ? result.stdout : null;
}

async function present(deps: ProbeDeps, names: readonly string[], dir: string): Promise<string[]> {
  const found = await Promise.all(
    names.map(async (name) => ((await deps.fs.kind(path.join(dir, name))) === null ? null : name)),
  );
  return found.filter((name) => name !== null);
}

/** Where git looks for hooks: core.hooksPath, else the hooks folder every worktree shares. */
async function hooksDirOf(deps: ProbeDeps, repoRoot: string): Promise<string | null> {
  const configured = await git(deps, repoRoot, ['config', '--get', 'core.hooksPath']);
  if (configured !== null && configured.trim() !== '') {
    return path.resolve(repoRoot, configured.trim());
  }
  const common = await git(deps, repoRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  return common === null ? null : path.join(common.trim(), 'hooks');
}

async function hookFindings(deps: ProbeDeps, repoRoot: string): Promise<readonly Finding[]> {
  const dir = await hooksDirOf(deps, repoRoot);
  const installed = dir === null ? [] : await deps.fs.readdir(dir);
  const active = installed.filter((name) => LANDING_HOOKS.has(name));
  if (active.length > 0) {
    return [
      info(`Git hooks run on commit and push (${active.join(', ')}), so they are the checks.`),
    ];
  }
  const managers = await present(deps, HOOK_MANAGERS, repoRoot);
  if (managers.length > 0) {
    return [
      warn(
        `${managers.join(' and ')} sets up git hooks, but none is installed, so commits and pushes run no checks. Install the hooks before committing.`,
      ),
    ];
  }
  return [
    warn(
      'No git hooks: nothing checks a commit or push. Run the tests for the files you change while you work, and the full suite once before landing, since CI is the only other gate.',
    ),
  ];
}

function githubRepo(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(url.trim());
  return match === null ? null : `${match[1] ?? ''}/${match[2] ?? ''}`;
}

function parseBranch(text: string): Branch | null {
  try {
    const data = branchSchema.safeParse(JSON.parse(text));
    return data.success ? data.data : null;
  } catch {
    return null;
  }
}

/** The branch as GitHub reports it, 'missing' without gh, or null when it cannot be read. */
async function readBranch(
  deps: ProbeDeps,
  repo: string,
  probe: ProbeTarget & { readonly target: string },
): Promise<Branch | 'missing' | null> {
  const result = await deps.exec(
    'gh',
    ['api', `repos/${repo}/branches/${encodeURIComponent(probe.target)}`],
    { cwd: probe.repoRoot, timeoutMs: GH_TIMEOUT_MS },
  );
  if (result.code === NOT_FOUND_CODE) {
    return 'missing';
  }
  return result.code === 0 ? parseBranch(result.stdout) : null;
}

/** The GitHub owner/name of origin, or null when origin is elsewhere or missing. */
async function originRepo(deps: ProbeDeps, repoRoot: string): Promise<string | null> {
  const url = await git(deps, repoRoot, ['remote', 'get-url', 'origin']);
  return url === null ? null : githubRepo(url);
}

async function protectionFindings(
  deps: ProbeDeps,
  probe: ProbeTarget,
  direct: boolean,
): Promise<readonly Finding[]> {
  const { target } = probe;
  const repo = target === null ? null : await originRepo(deps, probe.repoRoot);
  if (target === null || repo === null) {
    return [];
  }
  const branch = `${repo}:${target}`;
  const found = await readBranch(deps, repo, { ...probe, target });
  if (found === 'missing') {
    return [info(`gh is not installed, so the protection on ${branch} was not checked.`)];
  }
  if (found === null) {
    return [info(`Could not read the protection on ${branch}.`)];
  }
  const checks = found.protection?.required_status_checks;
  if (!found.protected || checks === undefined || checks.contexts.length === 0) {
    return [info(`${branch} requires no checks before a push lands, so CI runs only after it.`)];
  }
  const names = listed(checks.contexts);
  if (checks.enforcement_level !== 'everyone' && direct) {
    return [
      warn(
        `${branch} requires ${names} only for non-admins. An admin pushing straight to it lands before the checks run, so make sure they pass first.`,
      ),
    ];
  }
  return [info(`${branch} requires ${names} before a change lands.`)];
}

/** The shim names of the build tools the repository's tracked files point to. */
function buildTools(files: string): string[] {
  const tools = new Set<string>();
  for (const file of files.split('\n')) {
    if (file === '' || file.split('/').length > MARKER_DEPTH) {
      continue;
    }
    const name = path.posix.basename(file);
    for (const [marker, tool] of BUILD_MARKERS) {
      if (marker.test(name)) {
        tools.add(tool);
      }
    }
  }
  return [...tools].toSorted((a, b) => a.localeCompare(b));
}

async function shimFindings(deps: ProbeDeps, repoRoot: string): Promise<readonly Finding[]> {
  const shims = path.join(deps.home, '.claude', 'shims');
  if ((await deps.fs.kind(shims)) === null) {
    return [];
  }
  const used = buildTools((await git(deps, repoRoot, ['ls-files'])) ?? '');
  const covered = new Set(await present(deps, used, shims));
  const missing = used.filter((tool) => !covered.has(tool));
  if (missing.length > 0) {
    return [
      warn(
        `The repo builds with ${listed(missing)}, which has no shim in ~/.claude/shims, so its heavy commands do not take turns with other sessions. Run them as \`node ~/.claude/bin/slot.mjs <command>\`.`,
      ),
    ];
  }
  return used.length === 0
    ? []
    : [info(`Heavy ${listed(used)} commands take turns through ~/.claude/shims.`)];
}

async function portFindings(deps: ProbeDeps, repoRoot: string): Promise<readonly Finding[]> {
  if ((await git(deps, repoRoot, ['grep', '-q', '-I', '-e', 'OVERLORD_PORT_BASE'])) !== null) {
    return [info('The repo reads $OVERLORD_PORT_BASE, so each session gets its own ports.')];
  }
  const grep = ['grep', '-n', '-I', '-E', '-e', FIXED_PORT_ERE, '--', ...PORT_FILES];
  const lines = (await git(deps, repoRoot, grep)) ?? '';
  const ports = new Map<string, string>();
  for (const line of lines.split('\n')) {
    const file = line.split(':', 1)[0] ?? '';
    for (const [, port] of line.matchAll(FIXED_PORT)) {
      if (port !== undefined && !ports.has(port)) {
        ports.set(port, file);
      }
    }
  }
  if (ports.size === 0) {
    return [];
  }
  const where = [...ports].map(([port, file]) => `${port} in ${file}`);
  return [
    warn(
      `Fixed ports (${listed(where)}) and nothing reads $OVERLORD_PORT_BASE, so two sessions running the app at once collide. Use this session's ports, from $OVERLORD_PORT_BASE up, when you start it.`,
    ),
  ];
}

async function strayFindings(deps: ProbeDeps, repoRoot: string): Promise<readonly Finding[]> {
  const list = (await git(deps, repoRoot, ['worktree', 'list', '--porcelain'])) ?? '';
  const strays = list
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((dir) => dir !== repoRoot && !dir.startsWith(deps.worktreeRoot + path.sep))
    .map((dir) => shownPath(dir, deps.home, repoRoot));
  return strays.length === 0
    ? []
    : [info(`Worktrees made outside Overlord, which may hold unlanded work: ${listed(strays)}.`)];
}

/** Probes the repository and returns what a new session there should hear. */
export async function probeRepo(deps: ProbeDeps, probe: ProbeTarget): Promise<LaunchCheck> {
  const { repoRoot } = probe;
  const instructions = await repoInstructions(deps.fs, repoRoot);
  const landing = await landingFindings(deps, repoRoot, instructions);
  const groups = await Promise.all([
    protectionFindings(deps, probe, landing.direct),
    hookFindings(deps, repoRoot),
    shimFindings(deps, repoRoot),
    portFindings(deps, repoRoot),
    memoryFindings(deps, repoRoot, instructions),
    strayFindings(deps, repoRoot),
  ]);
  return { repoRoot, checkedAt: deps.now(), findings: [...landing.findings, ...groups.flat()] };
}
