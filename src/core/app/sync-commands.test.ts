import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { codexSync } from '../agents/codex/sync.js';
import { encodeProjectDir } from '../paths.js';
import type { Exec } from '../sync/exec.js';
import type { StatusEntry } from '../sync/git.js';
import type { FetchFunction } from '../sync/github.js';
import {
  bareRemoteWith,
  git,
  isolatedExec,
  repoWith,
  scratchDir,
} from '../sync/test-helpers/fixtures.js';

import { NOT_CONNECTED, readmeText, secretInChanges, SIGN_IN_MESSAGE } from './sync-commands.js';
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

const SESSION = { accessToken: 'gho_token', account: 'me' };

interface FetchCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/** GitHub's API for a user called me, whose overlord-config repo clones from `cloneUrl`. */
function gitHub(cloneUrl: string, exists: boolean): { fetch: FetchFunction; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const repo = { full_name: 'me/overlord-config', clone_url: cloneUrl };
  const fetch: FetchFunction = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method, url, body });
    await Promise.resolve();
    if (url.endsWith('/user')) {
      return Response.json({ login: 'me' });
    }
    if (method === 'POST') {
      return Response.json(repo, { status: 201 });
    }
    return exists ? Response.json(repo) : Response.json({ message: 'Not Found' }, { status: 404 });
  };
  return { fetch, calls };
}

async function emptyRemote(exec: Exec): Promise<string> {
  const bare = path.join(await scratchDir(), 'overlord-config.git');
  await exec('git', ['init', '-q', '--bare', bare], {});
  return bare;
}

describe('turnOn', () => {
  it('signs in, creates the GitHub repo, seeds it and saves its URL', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const remote = await emptyRemote(exec);
    const github = gitHub(remote, false);
    const { app } = makeApp(env, { deps: { exec, fetch: github.fetch } });
    env.host.gitHubSignIns.push(SESSION);
    await app.dispatch({ type: 'turnOnSync' }, {});
    expect(env.host.errors).toStrictEqual([]);
    expect(env.host.gitHubRequests[0]).toBe(true);
    expect(github.calls.map((call) => `${call.method} ${call.url}`)).toStrictEqual([
      'GET https://api.github.com/user',
      'GET https://api.github.com/repos/me/overlord-config',
      'POST https://api.github.com/user/repos',
    ]);
    expect(github.calls[2]?.body).toMatchObject({ name: 'overlord-config', private: true });
    expect(env.host.savedSettings).toStrictEqual([{ key: 'configRepo.url', value: remote }]);
    expect(env.host.infos).toStrictEqual([
      'Created the private repo me/overlord-config for your Claude config.',
      'Config synced.',
    ]);
    expect(await log(exec, remote)).toStrictEqual(['Start the config repo from test-host']);
    const manifest = await git(exec, remote, ['show', 'HEAD:overlord.json']);
    expect(JSON.parse(manifest)).toMatchObject({ version: 1, items: [] });
    expect(app.runtime.caches.config.peek().repo.connected).toBe(true);
  });

  it('stops when the GitHub sign in is cancelled', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const github = gitHub('unused', false);
    const { app } = makeApp(env, { deps: { exec, fetch: github.fetch } });
    await app.dispatch({ type: 'turnOnSync' }, {});
    expect(env.host.errors).toStrictEqual([SIGN_IN_MESSAGE]);
    expect(github.calls).toStrictEqual([]);
    await expect(lstat(path.join(env.home, '.overlord-config'))).rejects.toThrow();
  });

  it('finds an existing repo, shows the plan and applies it after a yes', async () => {
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
    const github = gitHub(remote, true);
    const { app } = makeApp(env, { deps: { exec, fetch: github.fetch } });
    env.host.gitHubSignedIn = SESSION;
    env.host.confirmAnswers.push(false);
    await app.dispatch({ type: 'turnOnSync' }, {});
    await expect(lstat(env.paths.userClaudeMd)).rejects.toThrow();
    expect(github.calls.map((call) => call.method)).toStrictEqual(['GET', 'GET']);
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'turnOnSync' }, {});
    const repo = path.join(env.home, '.overlord-config');
    expect(await readlink(env.paths.userClaudeMd)).toBe(path.join(repo, 'global', 'CLAUDE.md'));
    expect(github.calls).toHaveLength(2);
    expect(env.host.infos).toStrictEqual([
      'Found your config repo me/overlord-config.',
      'Config synced.',
      'Applied 1 change.',
      'Config synced.',
    ]);
    await expect(lstat(path.join(env.storageDir, 'memory-state.json'))).resolves.toBeDefined();
  });

  it('stops when a configured GitHub URL needs a sign in that does not happen', async () => {
    const env = await makeEnv({ settings: { configRepoUrl: 'https://github.com/me/c.git' } });
    const { app } = gitApp(env, isolatedExec());
    await app.dispatch({ type: 'turnOnSync' }, {});
    expect(env.host.gitHubRequests).toStrictEqual([true]);
    expect(env.host.errors).toStrictEqual([SIGN_IN_MESSAGE]);
    await expect(lstat(path.join(env.home, '.overlord-config'))).rejects.toThrow();
  });

  it('uses a configured URL without asking GitHub', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const remote = await bareRemoteWith(exec, { 'overlord.json': '{"version":1}\n' });
    env.host.settings = { ...env.host.settings, configRepoUrl: remote };
    const github = gitHub('unused', true);
    const { app } = makeApp(env, { deps: { exec, fetch: github.fetch } });
    await app.dispatch({ type: 'turnOnSync' }, {});
    expect(env.host.errors).toStrictEqual([]);
    expect(github.calls).toStrictEqual([]);
    expect(env.host.gitHubRequests).toStrictEqual([]);
    expect(env.host.savedSettings).toStrictEqual([]);
    expect(await remoteOf(exec, path.join(env.home, '.overlord-config'))).toBe(remote);
  });

  it('adopts an existing clone of the same repo, ssh or https', async () => {
    const env = await makeEnv({
      settings: { configRepoUrl: ' https://github.com/me/overlord-config ' },
    });
    const real = isolatedExec();
    // ssh that fails at once, so the sync after connecting never reaches GitHub.
    const exec: Exec = async (command, args, options) =>
      real(command, args, { ...options, env: { ...options.env, GIT_SSH_COMMAND: 'false' } });
    const repo = await cloneConfigRepo(env, exec);
    await git(exec, repo, ['remote', 'set-url', 'origin', 'git@github.com:me/overlord-config.git']);
    const { app } = gitApp(env, exec);
    await app.dispatch({ type: 'turnOnSync' }, {});
    expect(env.host.questions).toStrictEqual([]);
    expect(env.host.savedSettings).toStrictEqual([]);
    expect(env.host.errors).toHaveLength(1);
    expect(env.host.errors[0]).toMatch(/fetch --quiet failed/u);
  });

  it('refuses a folder that holds another repo, no remote, or no repo', async () => {
    const env = await makeEnv({ settings: { configRepoUrl: '/some/other.git' } });
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec);
    const { app } = gitApp(env, exec);
    await app.dispatch({ type: 'turnOnSync' }, {});
    await git(exec, repo, ['remote', 'remove', 'origin']);
    await app.dispatch({ type: 'turnOnSync' }, {});
    env.host.settings = { ...env.host.settings, configRepoPath: '~/plain' };
    await writeText(path.join(env.home, 'plain', 'file.txt'), 'x\n');
    await app.dispatch({ type: 'turnOnSync' }, {});
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

describe('push and pull over https to GitHub', () => {
  it('needs a sign in, then hands git the token', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec);
    const remote = await remoteOf(exec, repo);
    const github = 'https://github.com/me/overlord-config.git';
    await git(exec, repo, ['remote', 'set-url', 'origin', github]);
    // Pushes go to the local remote, so the test never reaches GitHub.
    await git(exec, repo, ['config', `url.${remote}.pushInsteadOf`, github]);
    await writeText(path.join(repo, 'a.txt'), 'a\n');
    const { app } = gitApp(env, exec);
    env.host.confirmAnswers.push(true, true);
    await app.dispatch({ type: 'syncPush' }, {});
    await app.dispatch({ type: 'syncPull' }, {});
    expect(env.host.errors).toStrictEqual([SIGN_IN_MESSAGE, SIGN_IN_MESSAGE]);
    env.host.gitHubSignedIn = SESSION;
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'syncPush' }, {});
    expect(env.host.infos).toStrictEqual(['Pushed the config repo (0 changed files).']);
    expect(await log(exec, remote)).toStrictEqual(['Update config from test-host', 'first']);
    expect(env.host.gitHubRequests).toStrictEqual([true, true, true]);
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

describe('readmeText', () => {
  it('names Claude Code and each agent that syncs, with where its files land', () => {
    const codex = {
      agent: 'codex',
      name: 'Codex CLI',
      short: 'Codex',
      sync: codexSync,
      dir: '/h/.codex',
      mcpStore: true,
    };
    const text = readmeText([codex], '/h');
    expect(text).toContain(
      '- Claude Code: overlord.json, global/ and the folders next to it land in ~/.claude',
    );
    expect(text).toContain(
      '- Codex CLI: agents/codex/, with its own overlord.json, lands in ~/.codex',
    );
    expect(readmeText([], '/h')).not.toContain('agents/codex/');
  });
});
