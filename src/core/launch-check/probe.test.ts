import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { claudeInstructions } from '../agents/claude/instructions.js';
import { codexInstructions } from '../agents/codex/instructions.js';
import { copilotInstructions } from '../agents/copilot/instructions.js';
import { recordingExec, ok } from '../app/test-helpers/fixtures.js';
import type { ExecCall } from '../app/test-helpers/fixtures.js';
import type { FileKind, FileSystem } from '../context/fs.js';
import type { ExecResult } from '../sync/exec.js';
import { NOT_FOUND_CODE } from '../sync/exec.js';

import type { AgentReads } from './instructions.js';
import type { Finding, ProbeDeps } from './probe.js';
import { probeRepo } from './probe.js';

const HOME = '/home/me';
const REPO = '/src/app';
const MEMORY = `${HOME}/.claude/projects/-src-app/memory`;
const SHIMS = `${HOME}/.claude/shims`;

/** A read-only file system over files; every folder above a file exists. */
function memoryFs(files: Readonly<Record<string, string>>): FileSystem {
  const dirs = new Set<string>();
  for (const file of Object.keys(files)) {
    for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      dirs.add(dir);
    }
  }
  const kind = async (target: string): Promise<FileKind | null> => {
    await Promise.resolve();
    if (target in files) {
      return 'file';
    }
    return dirs.has(target) ? 'directory' : null;
  };
  return {
    kind,
    readFile: async (target): Promise<string | null> => {
      await Promise.resolve();
      return files[target] ?? null;
    },
    readdir: async (target): Promise<readonly string[]> => {
      await Promise.resolve();
      const names = new Set<string>();
      for (const entry of [...Object.keys(files), ...dirs]) {
        if (path.dirname(entry) === target) {
          names.add(path.basename(entry));
        }
      }
      return [...names].toSorted((a, b) => a.localeCompare(b));
    },
    realpath: async (target) => ((await kind(target)) === null ? null : target),
  };
}

type Answers = Readonly<Record<string, ExecResult>>;

/** Answers git -C REPO <args> and gh <args> by their joined arguments. */
function answering(answers: Answers): (call: ExecCall) => ExecResult | undefined {
  return (call) => {
    const args = call.command === 'git' ? call.args.slice(2) : call.args;
    return answers[`${call.command} ${args.join(' ')}`];
  };
}

const PROTECTION = 'gh api repos/acme/app/branches/main';

const CLAUDE_READS: AgentReads = {
  policy: claudeInstructions,
  configDir: `${HOME}/.claude`,
  projectsDir: `${HOME}/.claude/projects`,
};

function deps(
  files: Readonly<Record<string, string>>,
  answers: Answers = {},
  reads: AgentReads | null = CLAUDE_READS,
): ProbeDeps {
  const { exec } = recordingExec(
    answering({
      'git rev-parse --path-format=absolute --git-common-dir': ok(`${REPO}/.git\n`),
      'git remote get-url origin': ok('git@github.com:acme/app.git\n'),
      ...answers,
    }),
  );
  return {
    exec,
    fs: memoryFs(files),
    home: HOME,
    reads,
    worktreeRoot: `${HOME}/.overlord/worktrees`,
    now: () => 42,
  };
}

async function findings(
  files: Readonly<Record<string, string>>,
  answers: Answers = {},
  target: string | null = 'main',
): Promise<readonly Finding[]> {
  const check = await probeRepo(deps(files, answers), { repoRoot: REPO, target });
  expect(check.repoRoot).toBe(REPO);
  expect(check.checkedAt).toBe(42);
  return check.findings;
}

/** The findings for sessions of the agent that reads what reads names. */
async function forAgent(
  reads: AgentReads | null,
  files: Readonly<Record<string, string>>,
): Promise<readonly Finding[]> {
  const check = await probeRepo(deps(files, {}, reads), { repoRoot: REPO, target: 'main' });
  return check.findings;
}

function texts(list: readonly Finding[], level: Finding['level']): string[] {
  return list.filter((finding) => finding.level === level).map((finding) => finding.text);
}

function protection(enforcement: string, contexts: readonly string[] = ['CI']): ExecResult {
  return ok(
    JSON.stringify({
      protected: true,
      protection: { required_status_checks: { enforcement_level: enforcement, contexts } },
    }),
  );
}

describe('probeRepo landing', () => {
  it('quotes both sides when the user and the repository disagree', async () => {
    const list = await findings({
      [`${HOME}/.claude/CLAUDE.md`]: '# Me\n\n- **No pull requests.** Push to main.\n',
      [`${REPO}/CLAUDE.md`]:
        '# App\n\nOnce tests pass, push the branch and open the pull request.\n',
    });
    expect(texts(list, 'warn')).toContain(
      'The instructions disagree on how work lands: ~/.claude/CLAUDE.md:3 ("- **No pull requests.** Push to main."), but CLAUDE.md:3 ("Once tests pass, push the branch and open the pull request."). Ask the user which applies before landing anything.',
    );
  });

  it('reads CLAUDE.md files one folder down', async () => {
    const list = await findings({
      [`${HOME}/.claude/CLAUDE.md`]: 'Open a pull request for every change.\n',
      [`${REPO}/web/CLAUDE.md`]: 'Push straight to main.\n',
    });
    expect(texts(list, 'warn')[0]).toContain('but web/CLAUDE.md:1 ("Push straight to main.")');
  });

  it('skips a line that says not to open one', async () => {
    const list = await findings({
      [`${HOME}/.claude/CLAUDE.md`]: 'No pull requests.\n',
      [`${REPO}/CLAUDE.md`]: 'Do not open a pull request here.\n',
    });
    expect(texts(list, 'warn').some((text) => text.includes('disagree'))).toBe(false);
    expect(texts(list, 'info')).toContain(
      'Work lands as ~/.claude/CLAUDE.md:1 ("No pull requests.") says.',
    );
  });

  it('names the repository rule first when nothing disagrees', async () => {
    const list = await findings({ [`${REPO}/CLAUDE.md`]: 'Run gh pr create when done.\n' });
    expect(texts(list, 'info')).toContain(
      'Work lands as CLAUDE.md:1 ("Run gh pr create when done.") says.',
    );
  });

  it('shortens a long quoted line', async () => {
    const list = await findings({ [`${REPO}/CLAUDE.md`]: `Open a PR. ${'x'.repeat(200)}\n` });
    const [rule] = texts(list, 'info');
    expect(rule).toContain('...")');
    expect(rule?.length).toBeLessThan(170);
  });

  it('reads AGENTS.md for Claude only where no CLAUDE.md hides it', async () => {
    const agents = { [`${REPO}/AGENTS.md`]: 'Run gh pr create when done.\n' };
    expect(texts(await findings(agents), 'info')).toContain(
      'Work lands as AGENTS.md:1 ("Run gh pr create when done.") says.',
    );
    const hidden = await findings({ ...agents, [`${REPO}/CLAUDE.md`]: '# App\n' });
    expect(texts(hidden, 'info').some((text) => text.includes('Work lands'))).toBe(false);
    const nested = await findings({
      [`${REPO}/CLAUDE.md`]: '# App\n',
      [`${REPO}/web/AGENTS.md`]: 'Push straight to main.\n',
    });
    expect(texts(nested, 'info')).toContain(
      'Work lands as web/AGENTS.md:1 ("Push straight to main.") says.',
    );
  });

  it("reads Codex's override first and its user file from its own folder", async () => {
    const reads: AgentReads = {
      policy: codexInstructions,
      configDir: `${HOME}/.codex`,
      projectsDir: `${HOME}/.claude/projects`,
    };
    const list = await forAgent(reads, {
      [`${HOME}/.codex/AGENTS.md`]: 'No pull requests.\n',
      [`${HOME}/.claude/CLAUDE.md`]: 'Open a pull request for every change.\n',
      [`${REPO}/AGENTS.override.md`]: 'Push straight to main.\n',
      [`${REPO}/AGENTS.md`]: 'Run gh pr create when done.\n',
      [`${REPO}/web/AGENTS.md`]: 'Open a PR.\n',
    });
    expect(texts(list, 'warn')).toStrictEqual([]);
    expect(texts(list, 'info')).toContain(
      'Work lands as AGENTS.override.md:1 ("Push straight to main.") says.',
    );
    // Codex keeps no auto memory.
    expect(texts(list, 'info').some((text) => text.includes('auto memory'))).toBe(false);
  });

  it("reads Copilot's files and none for an agent without a policy", async () => {
    const reads: AgentReads = {
      policy: copilotInstructions,
      configDir: `${HOME}/.copilot`,
      projectsDir: `${HOME}/.claude/projects`,
    };
    const files = {
      [`${HOME}/.copilot/copilot-instructions.md`]: 'No pull requests.\n',
      [`${REPO}/.github/copilot-instructions.md`]: 'Open a pull request for every change.\n',
    };
    expect(texts(await forAgent(reads, files), 'warn')[0]).toContain(
      '~/.copilot/copilot-instructions.md:1 ("No pull requests."), but .github/copilot-instructions.md:1',
    );
    const none = await forAgent(null, files);
    expect(none.some(({ text }) => text.includes('Work lands') || text.includes('disagree'))).toBe(
      false,
    );
  });
});

describe('probeRepo branch protection', () => {
  const direct = { [`${HOME}/.claude/CLAUDE.md`]: 'No pull requests.\n' };

  it('warns that an admin push skips checks enforced for non-admins only', async () => {
    const list = await findings(direct, { [PROTECTION]: protection('non_admins', ['Tests']) });
    expect(texts(list, 'warn')).toContain(
      'acme/app:main requires Tests only for non-admins. An admin pushing straight to it lands before the checks run, so make sure they pass first.',
    );
  });

  it('only notes checks enforced for everyone', async () => {
    const list = await findings(direct, { [PROTECTION]: protection('everyone', ['A', 'B']) });
    expect(texts(list, 'info')).toContain('acme/app:main requires A, B before a change lands.');
  });

  it('only notes non-admin checks when nothing pushes straight to the branch', async () => {
    const list = await findings({}, { [PROTECTION]: protection('non_admins') });
    expect(texts(list, 'info')).toContain('acme/app:main requires CI before a change lands.');
  });

  it('notes an unprotected branch', async () => {
    const list = await findings({}, { [PROTECTION]: ok('{"protected":false}') });
    expect(texts(list, 'info')).toContain(
      'acme/app:main requires no checks before a push lands, so CI runs only after it.',
    );
  });

  it('notes when gh is missing or the answer cannot be read', async () => {
    const missing = await findings(
      {},
      { [PROTECTION]: { code: NOT_FOUND_CODE, stdout: '', stderr: '' } },
    );
    expect(texts(missing, 'info')).toContain(
      'gh is not installed, so the protection on acme/app:main was not checked.',
    );
    const garbled = await findings({}, { [PROTECTION]: ok('not json') });
    expect(texts(garbled, 'info')).toContain('Could not read the protection on acme/app:main.');
  });

  it('skips a repository without a GitHub origin or a target', async () => {
    const other = await findings(
      {},
      { 'git remote get-url origin': ok('https://gitlab.com/a/b.git\n') },
    );
    expect(other.some((finding) => finding.text.includes('protection'))).toBe(false);
    const none = await findings({}, {}, null);
    expect(none.some((finding) => finding.text.includes('acme/app'))).toBe(false);
  });
});

describe('probeRepo git hooks', () => {
  it('notes the hooks that run on commit and push', async () => {
    const list = await findings({
      [`${REPO}/.git/hooks/pre-commit`]: '#!/bin/sh\n',
      [`${REPO}/.git/hooks/pre-push`]: '#!/bin/sh\n',
      [`${REPO}/.git/hooks/pre-push.sample`]: '#!/bin/sh\n',
    });
    expect(texts(list, 'info')).toContain(
      'Git hooks run on commit and push (pre-commit, pre-push), so they are the checks.',
    );
  });

  it('follows core.hooksPath, relative to the repository', async () => {
    const list = await findings(
      { [`${REPO}/.githooks/pre-push`]: '#!/bin/sh\n' },
      { 'git config --get core.hooksPath': ok('.githooks\n') },
    );
    expect(texts(list, 'info')).toContain(
      'Git hooks run on commit and push (pre-push), so they are the checks.',
    );
  });

  it('warns when a hook manager is set up but not installed', async () => {
    const list = await findings({ [`${REPO}/lefthook.yml`]: 'pre-commit:\n' });
    expect(texts(list, 'missing')).toContain(
      'Checks on commit and push: lefthook.yml sets up git hooks, but none is installed, so nothing checks a commit before it lands. Install the hooks.',
    );
  });

  it('warns when nothing checks a commit', async () => {
    const list = await findings(
      {},
      { 'git rev-parse --path-format=absolute --git-common-dir': ok('') },
    );
    expect(
      texts(list, 'missing').some((text) =>
        text.startsWith('Checks on commit and push: the repo has no git hooks'),
      ),
    ).toBe(true);
  });
});

describe('probeRepo shims', () => {
  const lsFiles = 'git ls-files';

  it('notes the tools whose heavy commands take turns', async () => {
    const list = await findings(
      { [`${SHIMS}/dotnet`]: '', [`${SHIMS}/npm`]: '' },
      { [lsFiles]: ok('app.slnx\nweb/package.json\na/b/c/d/Cargo.toml\nREADME.md\n') },
    );
    expect(texts(list, 'info')).toContain(
      'Heavy dotnet, npm commands take turns through ~/.claude/shims.',
    );
  });

  it('warns about a tool without a shim', async () => {
    const list = await findings(
      { [`${SHIMS}/npm`]: '' },
      { [lsFiles]: ok('CMakeLists.txt\npackage.json\n') },
    );
    expect(
      texts(list, 'warn').some((text) =>
        text.startsWith('The repo builds with cmake, which has no shim'),
      ),
    ).toBe(true);
  });

  it('says nothing when there are no shims or no build files', async () => {
    const without = await findings({}, { [lsFiles]: ok('package.json\n') });
    expect(without.some((finding) => finding.text.includes('shims'))).toBe(false);
    const empty = await findings({ [`${SHIMS}/npm`]: '' }, { [lsFiles]: ok('README.md\n') });
    expect(empty.some((finding) => finding.text.includes('shims'))).toBe(false);
  });
});

describe('probeRepo ports', () => {
  const portBase = 'git grep -q -I -e OVERLORD_PORT_BASE';

  it('notes a repository that reads OVERLORD_PORT_BASE', async () => {
    const list = await findings({}, { [portBase]: ok() });
    expect(texts(list, 'info')).toContain(
      'The repo reads $OVERLORD_PORT_BASE, so each session gets its own ports.',
    );
  });

  it('warns about fixed ports, one file per port', async () => {
    const grep = (call: ExecCall): ExecResult | undefined =>
      call.args.includes('-n')
        ? ok(
            [
              'web/Properties/launchSettings.json:12:      "applicationUrl": "https://localhost:5240;http://localhost:4473"',
              'web/appsettings.json:3:  "Url": "http://127.0.0.1:5240"',
            ].join('\n'),
          )
        : undefined;
    const base = deps({});
    const { exec } = recordingExec(grep, answering({ 'git remote get-url origin': ok('') }));
    const check = await probeRepo({ ...base, exec }, { repoRoot: REPO, target: null });
    expect(texts(check.findings, 'missing')).toContain(
      "Separate ports per session: the app uses fixed ports (5240 in web/Properties/launchSettings.json, 4473 in web/Properties/launchSettings.json) and nothing reads $OVERLORD_PORT_BASE, so two sessions running it at once collide. Use this session's ports, from $OVERLORD_PORT_BASE up, when you start it, and have the app read that variable.",
    );
  });
});

describe('probeRepo memory and worktrees', () => {
  it('counts memory entries and catches advice to make a worktree', async () => {
    const list = await findings({
      [`${MEMORY}/MEMORY.md`]: '- [One](one.md) - a\n- [Two](two.md) - b\n',
      [`${MEMORY}/one.md`]: 'At session start, run EnterWorktree.\n',
      [`${MEMORY}/two.md`]: 'Never use EnterWorktree here.\n',
    });
    expect(texts(list, 'info')).toContain(
      'Auto memory: 2 entries in ~/.claude/projects/-src-app/memory, shared with the main checkout.',
    );
    expect(texts(list, 'warn')).toContain(
      '~/.claude/projects/-src-app/memory/one.md:1 ("At session start, run EnterWorktree.") tells sessions to make their own worktree. A session Overlord starts already has one, so it should work there and not make another.',
    );
  });

  it('notes a repository without memory', async () => {
    expect(texts(await findings({}), 'info')).toContain('No auto memory for this repo yet.');
  });

  it('lists worktrees made outside Overlord', async () => {
    const list = await findings(
      {},
      {
        'git worktree list --porcelain': ok(
          [
            `worktree ${REPO}`,
            'HEAD abc',
            '',
            `worktree ${HOME}/.overlord/worktrees/app-1/x`,
            '',
            `worktree ${REPO}/.claude/worktrees/old`,
            '',
          ].join('\n'),
        ),
      },
    );
    expect(texts(list, 'info')).toContain(
      'Worktrees made outside Overlord, which may hold unlanded work: .claude/worktrees/old.',
    );
  });
});

describe('probeRepo setup for worktrees', () => {
  const ignored = 'git ls-files --others --ignored --exclude-standard --directory';
  const lsFiles = 'git ls-files';

  it('says Land cannot work without a default branch on origin', async () => {
    const list = await findings({}, {}, null);
    expect(texts(list, 'missing')[0]).toMatch(
      /^Landing: the repo has no default branch on origin/u,
    );
    expect(texts(await findings({}), 'missing').some((text) => text.startsWith('Landing'))).toBe(
      false,
    );
  });

  it('names ignored local files a worktree would miss without .worktreeinclude', async () => {
    const list = await findings(
      {},
      {
        [ignored]: ok(
          '.env\n.claude/settings.local.json\nnode_modules/\nweb/appsettings.Development.json\nbin/\nnotes.txt\n',
        ),
      },
    );
    expect(texts(list, 'missing')).toContain(
      'Worktree files: ignored files the app needs (.env, web/appsettings.Development.json) stay in the main checkout, and new worktrees start without them because the repo has no .worktreeinclude. List them there, in gitignore syntax, and Overlord copies them in.',
    );
  });

  it('says nothing is restored for tools other than npm without a setup script', async () => {
    const list = await findings({}, { [lsFiles]: ok('app.slnx\npackage.json\nMakefile\n') });
    expect(texts(list, 'missing')).toContain(
      'Worktree setup: Overlord only clones node_modules into a new worktree, and the repo has no .overlord/setup.sh, so nothing restores its dotnet dependencies. The first build in each worktree has to, or add that script to do it.',
    );
    const npmOnly = await findings({}, { [lsFiles]: ok('package.json\n') });
    expect(texts(npmOnly, 'missing').some((text) => text.startsWith('Worktree setup'))).toBe(false);
  });

  it('notes the files that set up new worktrees', async () => {
    const list = await findings(
      {
        [`${REPO}/.worktreeinclude`]: '.env\n',
        [`${REPO}/.overlord/setup.sh`]: 'dotnet restore\n',
      },
      { [ignored]: ok('.env\n'), [lsFiles]: ok('app.slnx\n') },
    );
    expect(texts(list, 'missing').some((text) => text.startsWith('Worktree'))).toBe(false);
    expect(texts(list, 'info')).toContain(
      'New worktrees are set up by .worktreeinclude and .overlord/setup.sh.',
    );
  });
});
