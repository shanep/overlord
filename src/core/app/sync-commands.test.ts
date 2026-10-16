import { lstat, mkdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { encodeProjectDir } from '../paths.js';
import type { Exec } from '../sync/exec.js';
import type { StatusEntry } from '../sync/git.js';
import { bareRemoteWith, git, isolatedExec, repoWith } from '../sync/test-helpers/fixtures.js';

import { NOT_CONNECTED, secretInChanges } from './sync-commands.js';
import type { TestApp, TestEnv } from './test-helpers/fixtures.js';
import {
  cloneConfigRepo,
  makeApp,
  makeEnv,
  writeJson,
  writeText,
} from './test-helpers/fixtures.js';

const KEY = `sk-ant-${'a'.repeat(30)}`;

function gitApp(env: TestEnv, exec: Exec): TestApp {
  return makeApp(env, { deps: { exec } });
}

async function remoteOf(exec: Exec, repo: string): Promise<string> {
  const url = await git(exec, repo, ['remote', 'get-url', 'origin']);
  return url.trim();
}

async function log(exec: Exec, repo: string): Promise<string[]> {
  const out = await git(exec, repo, ['log', '--format=%s']);
  return out.trim().split('\n');
}

function entry(file: string): StatusEntry {
  return { code: ' M', path: file, origPath: null };
}

describe('secretInChanges', () => {
  it('names the first changed file that holds a token and skips deleted files', async () => {
    const env = await makeEnv();
    await writeText(path.join(env.root, 'clean.txt'), 'nothing here\n');
    await writeText(path.join(env.root, 'leak.txt'), `one\n${KEY}\n`);
    await expect(
      secretInChanges(env.root, [entry('gone.txt'), entry('clean.txt'), entry('leak.txt')]),
    ).resolves.toBe('leak.txt line 2 looks like a secret (anthropic-key).');
    await expect(secretInChanges(env.root, [entry('clean.txt')])).resolves.toBeNull();
  });
});

describe('connectConfigRepo', () => {
  it('does nothing when cancelled or left blank', async () => {
    const env = await makeEnv({ settings: { configRepoUrl: 'git@github.com:me/c.git' } });
    const { app } = makeApp(env);
    env.host.inputAnswers.push(null, ' '.repeat(3));
    await app.sync.connectConfigRepo();
    await app.sync.connectConfigRepo();
    expect(env.host.inputs).toStrictEqual([
      { prompt: 'Git URL of your config repo', value: 'git@github.com:me/c.git' },
      { prompt: 'Git URL of your config repo', value: 'git@github.com:me/c.git' },
    ]);
    expect(env.host.questions).toStrictEqual([]);
  });

  it('clones after asking', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const remote = await bareRemoteWith(exec, { 'overlord.json': '{"version":1}\n' });
    env.host.settings = { ...env.host.settings, configRepoPath: '~/nested/config' };
    const { app } = gitApp(env, exec);
    const dir = path.join(env.home, 'nested', 'config');
    env.host.inputAnswers.push(remote, remote);
    env.host.confirmAnswers.push(false, true);
    await app.sync.connectConfigRepo();
    await expect(lstat(dir)).rejects.toThrow();
    await app.sync.connectConfigRepo();
    expect(env.host.questions.map((question) => question.message)).toStrictEqual([
      `Clone ${remote} into ${dir}?`,
      `Clone ${remote} into ${dir}?`,
    ]);
    expect(env.host.questions[0]?.action).toBe('Clone');
    expect(env.host.infos).toStrictEqual([`Cloned the config repo into ${dir}.`]);
    expect(await remoteOf(exec, dir)).toBe(remote);
    expect(app.runtime.caches.config.peek().repo.connected).toBe(true);
  });

  it('adopts an existing clone of the same repo, ssh or https', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec);
    await git(exec, repo, ['remote', 'set-url', 'origin', 'git@github.com:me/claude-config.git']);
    const { app } = gitApp(env, exec);
    env.host.inputAnswers.push(' https://github.com/me/claude-config ');
    await app.sync.connectConfigRepo();
    expect(env.host.infos).toStrictEqual([`Connected to the clone in ${repo}.`]);
    expect(env.host.questions).toStrictEqual([]);
  });

  it('refuses a folder that holds another repo, no remote, or no repo', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec);
    const { app } = gitApp(env, exec);
    env.host.inputAnswers.push('/some/other.git');
    await app.sync.connectConfigRepo();
    await git(exec, repo, ['remote', 'remove', 'origin']);
    env.host.inputAnswers.push('/some/other.git');
    await app.sync.connectConfigRepo();
    env.host.settings = { ...env.host.settings, configRepoPath: '~/plain' };
    await mkdir(path.join(env.home, 'plain'));
    env.host.inputAnswers.push('/some/other.git');
    await app.sync.connectConfigRepo();
    expect(env.host.errors).toStrictEqual([
      `${repo} holds a different repo. Change overlord.configRepo.path or move it.`,
      `${repo} holds a different repo. Change overlord.configRepo.path or move it.`,
      `${path.join(env.home, 'plain')} exists and is not a git clone.`,
    ]);
  });
});

describe('push', () => {
  it('needs a connected repo and a yes', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const { app } = gitApp(env, exec);
    await app.dispatch({ type: 'syncPush' }, {});
    expect(env.host.infos).toStrictEqual([NOT_CONNECTED]);
    await cloneConfigRepo(env, exec);
    await app.dispatch({ type: 'syncPush' }, {});
    expect(env.host.questions).toStrictEqual([
      {
        message: 'Sync auto memory, commit every change in the config repo and push it?',
        action: 'Push',
      },
    ]);
    expect(env.host.infos).toStrictEqual([NOT_CONNECTED]);
  });

  it('says when there is nothing to push', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    await cloneConfigRepo(env, exec);
    const { app } = gitApp(env, exec);
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'syncPush' }, {});
    expect(env.host.infos).toStrictEqual(['Nothing to push.']);
  });

  it('commits and pushes changes, and pushes commits that are only ahead', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec);
    const remote = await remoteOf(exec, repo);
    await writeText(path.join(repo, 'agents', 'a.md'), '# a\n');
    await git(exec, repo, ['rm', '-q', 'overlord.json']);
    await writeText(path.join(repo, 'overlord.json'), '{"version":1,"memory":{"enabled":false}}\n');
    const { app } = gitApp(env, exec);
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'syncPush' }, {});
    expect(env.host.errors).toStrictEqual([]);
    expect(env.host.infos).toStrictEqual(['Pushed the config repo (3 changed files).']);
    expect(await log(exec, remote)).toStrictEqual(['Update config from test-host', 'first']);
    await writeText(path.join(repo, 'b.txt'), 'b\n');
    await git(exec, repo, ['add', '-A']);
    await git(exec, repo, ['commit', '-q', '-m', 'by hand']);
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'syncPush' }, {});
    expect(env.host.infos[1]).toBe('Pushed the config repo (0 changed files).');
    const history = await log(exec, remote);
    expect(history[0]).toBe('by hand');
    expect(app.runtime.caches.config.peek().repo.ahead).toBe(0);
  });

  it('stops before committing a file that looks like a secret', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec);
    await writeText(path.join(repo, 'mcp.json'), `{"token":"${KEY}"}\n`);
    const { app } = gitApp(env, exec);
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'syncPush' }, {});
    expect(env.host.errors).toStrictEqual([
      'Push stopped: mcp.json line 1 looks like a secret (anthropic-key).',
    ]);
    expect(await log(exec, repo)).toStrictEqual(['first']);
  });

  it('syncs auto memory into the repo and keeps secrets out', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec);
    const project = await repoWith(exec, { 'README.md': 'x\n' });
    await git(exec, project, ['remote', 'add', 'origin', 'git@github.com:me/proj.git']);
    await writeJson(env.paths.claudeJson, { projects: { [project]: {}, '': {} } });
    const memory = path.join(env.paths.projectsDir, encodeProjectDir(project), 'memory');
    await writeText(path.join(memory, 'note.md'), 'remember this\n');
    await writeText(path.join(memory, 'leak.md'), `${KEY}\n`);
    const { app } = gitApp(env, exec);
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'syncPush' }, {});
    expect(env.host.warnings).toStrictEqual([
      'Kept 1 memory file out of the repo because they look like they hold secrets.',
    ]);
    const copied = path.join(repo, 'memory', 'github.com', 'me', 'proj', 'note.md');
    expect(await readFile(copied, 'utf8')).toBe('remember this\n');
    expect(env.host.infos).toStrictEqual(['Pushed the config repo (1 changed file).']);
  });

  it('skips memory sync when the repo has no manifest', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    await cloneConfigRepo(env, exec, { 'README.md': 'x\n' });
    const { app } = gitApp(env, exec);
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'syncPush' }, {});
    expect(env.host.infos).toStrictEqual(['Nothing to push.']);
    await expect(lstat(path.join(env.storageDir, 'memory-state.json'))).rejects.toThrow();
  });
});

describe('pull', () => {
  it('needs a connected repo and a yes, then pulls', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const { app } = gitApp(env, exec);
    await app.dispatch({ type: 'syncPull' }, {});
    expect(env.host.infos).toStrictEqual([NOT_CONNECTED]);
    const repo = await cloneConfigRepo(env, exec);
    const other = path.join(env.root, 'other');
    await git(exec, env.root, ['clone', '-q', await remoteOf(exec, repo), other]);
    await writeText(path.join(other, 'new.txt'), 'new\n');
    await git(exec, other, ['add', '-A']);
    await git(exec, other, ['commit', '-q', '-m', 'elsewhere']);
    await git(exec, other, ['push', '-q']);
    await app.dispatch({ type: 'syncPull' }, {});
    await expect(lstat(path.join(repo, 'new.txt'))).rejects.toThrow();
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'syncPull' }, {});
    expect(await readFile(path.join(repo, 'new.txt'), 'utf8')).toBe('new\n');
    expect(env.host.infos).toStrictEqual([NOT_CONNECTED, 'Pulled the config repo.']);
    expect(env.host.questions.map((question) => question.action)).toStrictEqual(['Pull', 'Pull']);
  });

  it('shows a failed pull as an error', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec);
    await git(exec, repo, ['remote', 'set-url', 'origin', path.join(env.root, 'gone.git')]);
    const { app } = gitApp(env, exec);
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'syncPull' }, {});
    expect(env.host.errors).toHaveLength(1);
    expect(env.host.errors[0]).toMatch(/^git -C .* pull -q --ff-only failed/u);
  });
});

describe('importDotfiles', () => {
  it('needs a repo and a folder', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const { app } = gitApp(env, exec);
    await app.sync.importDotfiles();
    expect(env.host.infos).toStrictEqual([NOT_CONNECTED]);
    await cloneConfigRepo(env, exec);
    await app.sync.importDotfiles();
    expect(env.host.folderPicks).toStrictEqual(['Pick the claude folder in your dot-files repo']);
    expect(env.host.opened).toStrictEqual([]);
  });

  it('shows the dry run, asks, and moves the files into the repo', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec);
    const dotfiles = path.join(env.root, 'dot-files', 'claude');
    await writeText(path.join(dotfiles, 'CLAUDE.md'), '# me\n');
    await writeText(path.join(dotfiles, 'junk.txt'), 'junk\n');
    const { app } = gitApp(env, exec);
    env.host.folderAnswers.push(dotfiles, dotfiles);
    env.host.confirmAnswers.push(false, true);
    await app.sync.importDotfiles();
    const dryRun = path.join(env.storageDir, 'dry-run.txt');
    expect(env.host.opened).toStrictEqual([dryRun]);
    const text = await readFile(dryRun, 'utf8');
    expect(text).toMatch(/^\d+ changes planned:\n/u);
    expect(text).toContain(`skipped ${path.join(dotfiles, 'junk.txt')}: not a Claude config file`);
    await expect(lstat(path.join(repo, 'global', 'CLAUDE.md'))).rejects.toThrow();
    await app.sync.importDotfiles();
    expect(env.host.questions[1]?.message).toMatch(
      /^Apply the \d+ changes shown in the dry run\?$/u,
    );
    expect(env.host.questions[1]?.action).toBe('Apply');
    expect(await readlink(env.paths.userClaudeMd)).toBe(path.join(repo, 'global', 'CLAUDE.md'));
    expect(env.host.infos).toHaveLength(1);
    expect(env.host.infos[0]).toMatch(/^Applied \d+ changes\. Backup in ~\/\.claude\/backups\//u);
  });
});

describe('bootstrap', () => {
  it('asks for a URL when none is configured and stops on cancel or no', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const { app } = gitApp(env, exec);
    await app.sync.bootstrap();
    env.host.inputAnswers.push('git@github.com:me/c.git');
    await app.sync.bootstrap();
    expect(env.host.inputs).toStrictEqual([
      { prompt: 'Git URL of your config repo', value: '' },
      { prompt: 'Git URL of your config repo', value: '' },
    ]);
    expect(env.host.questions).toStrictEqual([
      {
        message: `Clone git@github.com:me/c.git into ${path.join(env.home, '.claude-config')} if needed and plan the setup?`,
        action: 'Continue',
      },
    ]);
  });

  it('clones the configured repo, shows the plan and applies it', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const manifest = {
      version: 1,
      items: [
        {
          id: 'claude-md',
          kind: 'claude-md',
          source: 'global/CLAUDE.md',
          target: '~/.claude/CLAUDE.md',
          mode: 'link',
        },
      ],
    };
    const remote = await bareRemoteWith(exec, {
      'overlord.json': JSON.stringify(manifest),
      'global/CLAUDE.md': '# shared\n',
    });
    env.host.settings = { ...env.host.settings, configRepoUrl: remote };
    const { app } = gitApp(env, exec);
    env.host.confirmAnswers.push(true, false);
    await app.sync.bootstrap();
    await expect(lstat(env.paths.userClaudeMd)).rejects.toThrow();
    await expect(lstat(path.join(env.storageDir, 'memory-state.json'))).rejects.toThrow();
    env.host.confirmAnswers.push(true, true);
    await app.sync.bootstrap();
    const repo = path.join(env.home, '.claude-config');
    expect(await readlink(env.paths.userClaudeMd)).toBe(path.join(repo, 'global', 'CLAUDE.md'));
    expect(env.host.inputs).toStrictEqual([]);
    expect(env.host.infos).toStrictEqual(['Applied 1 change.']);
    await expect(lstat(path.join(env.storageDir, 'memory-state.json'))).resolves.toBeDefined();
  });
});
