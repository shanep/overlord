// The compatibility check's findings about how a repository is set up for
// Overlord: a default branch on origin to branch from and land on, ignored
// files and dependencies a new worktree needs, git hooks that check a commit,
// and ports that do not clash between sessions. Each one that is missing
// names the Overlord feature it costs and how to set it up.

import path from 'node:path';

import type { Exec } from '../sync/exec.js';

import type { Finding, InstructionDeps } from './instructions.js';
import { info, listed, missing } from './instructions.js';

export interface ProbeDeps extends InstructionDeps {
  readonly exec: Exec;
  /** Where Overlord makes worktrees, so the ones it made are not called strays. */
  readonly worktreeRoot: string;
  readonly now: () => number;
}

const GIT_TIMEOUT_MS = 10_000;
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
// Tools whose dependencies a new worktree lacks: Overlord only clones node_modules.
const NEEDS_SETUP = new Set(['dotnet', 'cargo', 'go', 'pytest', 'mvn', 'gradle', 'cmake']);
const HOOK_MANAGERS = [
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.husky',
  '.pre-commit-config.yaml',
];
const LANDING_HOOKS = new Set(['pre-commit', 'pre-push', 'commit-msg', 'pre-merge-commit']);
// Ignored files a checkout needs to run, by name: env files, local settings and secrets.
// Claude Code's own .claude folder is left out, since it is not the app's.
const LOCAL_FILES = [
  /^\.env(?:$|\.)/u,
  /\.local(?:$|\.)/u,
  /^appsettings\.[\w-]+\.json$/u,
  /^secrets?\.[\w-]+$/u,
  /^\.npmrc$/u,
];
const INCLUDE_FILE = '.worktreeinclude';
const SETUP_SCRIPT = path.join('.overlord', 'setup.sh');

export async function git(
  deps: ProbeDeps,
  repoRoot: string,
  args: readonly string[],
): Promise<string | null> {
  const result = await deps.exec('git', ['-C', repoRoot, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  return result.code === 0 ? result.stdout : null;
}

export async function present(
  deps: ProbeDeps,
  names: readonly string[],
  dir: string,
): Promise<string[]> {
  const found = await Promise.all(
    names.map(async (name) => ((await deps.fs.kind(path.join(dir, name))) === null ? null : name)),
  );
  return found.filter((name) => name !== null);
}

/** The shim names of the build tools the repository's tracked files point to. */
export function buildTools(files: string): string[] {
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

export function originFindings(target: string | null): readonly Finding[] {
  return target === null
    ? [
        missing(
          'Landing: the repo has no default branch on origin, so new Overlord worktrees branch from the local HEAD and Land cannot push their work. Add an origin remote and push the default branch to it.',
        ),
      ]
    : [];
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

export async function hookFindings(deps: ProbeDeps, repoRoot: string): Promise<readonly Finding[]> {
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
      missing(
        `Checks on commit and push: ${managers.join(' and ')} sets up git hooks, but none is installed, so nothing checks a commit before it lands. Install the hooks.`,
      ),
    ];
  }
  return [
    missing(
      'Checks on commit and push: the repo has no git hooks, so nothing checks a commit before it lands and each session has to run the checks itself. Run the tests for the files you change while you work, and the full suite once before landing. Adding pre-commit and pre-push hooks fixes this.',
    ),
  ];
}

export async function portFindings(deps: ProbeDeps, repoRoot: string): Promise<readonly Finding[]> {
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
    missing(
      `Separate ports per session: the app uses fixed ports (${listed(where)}) and nothing reads $OVERLORD_PORT_BASE, so two sessions running it at once collide. Use this session's ports, from $OVERLORD_PORT_BASE up, when you start it, and have the app read that variable.`,
    ),
  ];
}

/** Ignored files in the main checkout that a new worktree would need, such as .env. */
async function localFiles(deps: ProbeDeps, repoRoot: string): Promise<string[]> {
  const ignored =
    (await git(deps, repoRoot, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
    ])) ?? '';
  return ignored
    .split('\n')
    .filter(
      (file) =>
        file !== '' &&
        !file.startsWith('.claude/') &&
        file.split('/').length <= MARKER_DEPTH &&
        LOCAL_FILES.some((pattern) => pattern.test(path.posix.basename(file))),
    );
}

/** What a new worktree gets beyond the tracked files: ignored files and dependencies. */
export async function setupFindings(
  deps: ProbeDeps,
  repoRoot: string,
  tools: readonly string[],
): Promise<readonly Finding[]> {
  const [include, script] = await Promise.all([
    present(deps, [INCLUDE_FILE], repoRoot),
    present(deps, [SETUP_SCRIPT], repoRoot),
  ]);
  const findings: Finding[] = [];
  const local = include.length > 0 ? [] : await localFiles(deps, repoRoot);
  if (local.length > 0) {
    findings.push(
      missing(
        `Worktree files: ignored files the app needs (${listed(local)}) stay in the main checkout, and new worktrees start without them because the repo has no ${INCLUDE_FILE}. List them there, in gitignore syntax, and Overlord copies them in.`,
      ),
    );
  }
  const needed = tools.filter((tool) => NEEDS_SETUP.has(tool));
  if (script.length === 0 && needed.length > 0) {
    findings.push(
      missing(
        `Worktree setup: Overlord only clones node_modules into a new worktree, and the repo has no ${SETUP_SCRIPT}, so nothing restores its ${listed(needed)} dependencies. The first build in each worktree has to, or add that script to do it.`,
      ),
    );
  }
  if (include.length > 0 || script.length > 0) {
    findings.push(info(`New worktrees are set up by ${[...include, ...script].join(' and ')}.`));
  }
  return findings;
}
