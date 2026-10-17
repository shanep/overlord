import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { recordingExec, ok } from '../app/test-helpers/fixtures.js';
import type { ExecCall } from '../app/test-helpers/fixtures.js';
import type { FileKind, FileSystem } from '../context/fs.js';
import type { ExecResult } from '../sync/exec.js';
import { NOT_FOUND_CODE } from '../sync/exec.js';

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

function deps(files: Readonly<Record<string, string>>, answers: Answers = {}): ProbeDeps {
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
    userClaudeMd: `${HOME}/.claude/CLAUDE.md`,
    projectsDir: `${HOME}/.claude/projects`,
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
    expect(texts(list, 'warn')).toContain(
      'lefthook.yml sets up git hooks, but none is installed, so commits and pushes run no checks. Install the hooks before committing.',
    );
  });

  it('warns when nothing checks a commit', async () => {
    const list = await findings(
      {},
      { 'git rev-parse --path-format=absolute --git-common-dir': ok('') },
    );
    expect(texts(list, 'warn').some((text) => text.startsWith('No git hooks'))).toBe(true);
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
    expect(texts(check.findings, 'warn')).toContain(
      "Fixed ports (5240 in web/Properties/launchSettings.json, 4473 in web/Properties/launchSettings.json) and nothing reads $OVERLORD_PORT_BASE, so two sessions running the app at once collide. Use this session's ports, from $OVERLORD_PORT_BASE up, when you start it.",
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
      '~/.claude/projects/-src-app/memory/one.md:1 ("At session start, run EnterWorktree.") tells sessions to make a worktree, but Overlord already made this one. Work here and do not make another.',
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
