// Checks how ready a repository is for Overlord, for each new session that
// starts in it: what is set up (see repo.ts), whether the instructions agree
// on how work lands (see instructions.ts), what branch protection checks a
// push, whether heavy commands take turns, and what stray worktrees come
// along. Every probe runs git, gh or a file read in the background, so the
// hook reply never waits on one, and a probe that fails adds nothing.

import path from 'node:path';

import { z } from 'zod';

import { NOT_FOUND_CODE } from '../sync/exec.js';

import type { Finding } from './instructions.js';
import {
  info,
  landingFindings,
  listed,
  memoryFindings,
  repoInstructions,
  shownPath,
  warn,
} from './instructions.js';
import type { ProbeDeps } from './repo.js';
import {
  buildTools,
  git,
  hookFindings,
  originFindings,
  portFindings,
  present,
  setupFindings,
} from './repo.js';

export type { Finding } from './instructions.js';
export type { ProbeDeps } from './repo.js';

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

const GH_TIMEOUT_MS = 15_000;

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

/** The GitHub owner/name of origin, or null when origin is elsewhere or missing. */
async function originRepo(deps: ProbeDeps, repoRoot: string): Promise<string | null> {
  const url = await git(deps, repoRoot, ['remote', 'get-url', 'origin']);
  return url === null ? null : githubRepo(url);
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

async function shimFindings(deps: ProbeDeps, used: readonly string[]): Promise<readonly Finding[]> {
  const shims = path.join(deps.home, '.claude', 'shims');
  if ((await deps.fs.kind(shims)) === null) {
    return [];
  }
  const covered = new Set(await present(deps, used, shims));
  const absent = used.filter((tool) => !covered.has(tool));
  if (absent.length > 0) {
    return [
      warn(
        `The repo builds with ${listed(absent)}, which has no shim in ~/.claude/shims, so its heavy commands do not take turns with other sessions. Run them as \`node ~/.claude/bin/slot.mjs <command>\`.`,
      ),
    ];
  }
  return used.length === 0
    ? []
    : [info(`Heavy ${listed(used)} commands take turns through ~/.claude/shims.`)];
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
  const tools = buildTools((await git(deps, repoRoot, ['ls-files'])) ?? '');
  const groups = await Promise.all([
    setupFindings(deps, repoRoot, tools),
    hookFindings(deps, repoRoot),
    portFindings(deps, repoRoot),
    protectionFindings(deps, probe, landing.direct),
    shimFindings(deps, tools),
    memoryFindings(deps, repoRoot, instructions),
    strayFindings(deps, repoRoot),
  ]);
  return {
    repoRoot,
    checkedAt: deps.now(),
    findings: [...landing.findings, ...originFindings(probe.target), ...groups.flat()],
  };
}
