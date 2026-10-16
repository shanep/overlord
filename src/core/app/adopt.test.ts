import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ConfigItem } from '../../shared/model.js';
import type { Action } from '../sync/actions.js';
import { applyPlan } from '../sync/apply.js';
import { isolatedExec } from '../sync/test-helpers/fixtures.js';

import { manifestItemFor, planAdopt, planLinkBack } from './adopt.js';
import { applyDeps, changeCount, confirmAndApply, reportApply } from './apply-plan.js';
import { memoryProjects, runMemorySync } from './memory.js';
import {
  cloneConfigRepo,
  makeApp,
  makeEnv,
  session,
  writeJson,
  writeText,
} from './test-helpers/fixtures.js';

type Item = Pick<ConfigItem, 'kind' | 'scope' | 'path'>;

function userItem(kind: Item['kind'], file: string): Item {
  return { kind, scope: 'user', path: file };
}

describe('manifestItemFor', () => {
  it('maps user files to their place in the repo', async () => {
    const env = await makeEnv();
    const { paths } = env;
    expect(manifestItemFor(userItem('claude-md', paths.userClaudeMd), paths)).toStrictEqual({
      id: 'claude-md',
      kind: 'claude-md',
      source: 'global/CLAUDE.md',
      target: '~/.claude/CLAUDE.md',
      mode: 'link',
    });
    expect(
      manifestItemFor(
        userItem('keybindings', path.join(paths.configDir, 'keybindings.json')),
        paths,
      ),
    ).toStrictEqual({
      id: 'keybindings',
      kind: 'keybindings',
      source: 'global/keybindings.json',
      target: '~/.claude/keybindings.json',
      mode: 'link',
    });
    expect(
      manifestItemFor(userItem('skill', path.join(paths.userSkillsDir, 'tidy')), paths),
    ).toStrictEqual({
      id: 'skill:tidy',
      kind: 'skill',
      source: 'skills/tidy',
      target: '~/.claude/skills/tidy',
      mode: 'link',
    });
    expect(
      manifestItemFor(
        userItem('command', path.join(paths.userCommandsDir, 'git', 'ship.md')),
        paths,
      ),
    ).toMatchObject({ id: 'command:git/ship', source: 'commands/git/ship.md' });
    expect(
      manifestItemFor(userItem('rule', path.join(paths.userRulesDir, 'r.md')), paths),
    ).toMatchObject({
      id: 'rule:r',
      source: 'global/rules/r.md',
    });
    expect(
      manifestItemFor(
        userItem('output-style', path.join(paths.userOutputStylesDir, 'terse.md')),
        paths,
      ),
    ).toMatchObject({ id: 'output-style:terse', source: 'output-styles/terse.md' });
    expect(
      manifestItemFor(userItem('agent', path.join(paths.userAgentsDir, 'a.md')), paths),
    ).toMatchObject({
      id: 'agent:a',
      source: 'agents/a.md',
      target: '~/.claude/agents/a.md',
    });
  });

  it('returns null for anything it cannot link', async () => {
    const env = await makeEnv();
    const { paths } = env;
    expect(manifestItemFor({ kind: 'agent', scope: 'project', path: '/p/a.md' }, paths)).toBeNull();
    expect(manifestItemFor({ kind: 'agent', scope: 'user', path: null }, paths)).toBeNull();
    expect(
      manifestItemFor({ kind: 'agent', scope: 'user', path: '/outside/a.md' }, paths),
    ).toBeNull();
    expect(
      manifestItemFor(
        { kind: 'agent', scope: 'user', path: path.join(paths.userRulesDir, 'a.md') },
        paths,
      ),
    ).toBeNull();
    expect(
      manifestItemFor(
        { kind: 'claude-md', scope: 'user', path: path.join(paths.configDir, 'x.md') },
        paths,
      ),
    ).toBeNull();
    expect(
      manifestItemFor({ kind: 'keybindings', scope: 'user', path: paths.userClaudeMd }, paths),
    ).toBeNull();
    expect(
      manifestItemFor({ kind: 'settings', scope: 'user', path: paths.userSettings }, paths),
    ).toBeNull();
    expect(
      manifestItemFor({ kind: 'agent', scope: 'user', path: paths.userAgentsDir }, paths),
    ).toBeNull();
  });
});

describe('planAdopt and planLinkBack', () => {
  it('skips the copy when the repo already has the same content', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec, {
      'overlord.json': '{"version":1}\n',
      'agents/a.md': '# a\n',
    });
    const target = await writeText(path.join(env.paths.userAgentsDir, 'a.md'), '# a\n');
    const item = manifestItemFor({ kind: 'agent', scope: 'user', path: target }, env.paths);
    if (item === null) {
      throw new Error('no item');
    }
    const plan = await planAdopt(repo, item, target);
    expect(plan.ok).toBe(true);
    const kinds = plan.ok ? plan.actions.map((action) => action.kind) : [];
    expect(kinds).toStrictEqual(['backup', 'link', 'backup', 'write-file']);
  });

  it('starts a manifest when the repo has none', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec, { 'README.md': 'x\n' });
    const actions = await planLinkBack(
      repo,
      {
        id: 'agent:a',
        kind: 'agent',
        source: 'agents/a.md',
        target: '~/.claude/agents/a.md',
        mode: 'link',
      },
      path.join(env.paths.userAgentsDir, 'a.md'),
    );
    const write = actions.find((action) => action.kind === 'write-file');
    const content: unknown = write?.kind === 'write-file' ? JSON.parse(write.content) : null;
    expect(content).toMatchObject({
      version: 1,
      items: [{ id: 'agent:a' }],
    });
    expect(actions.map((action) => action.kind)).toStrictEqual(['mkdir', 'link', 'write-file']);
  });
});

describe('apply-plan', () => {
  it('counts changes without notes', () => {
    const actions: Action[] = [
      { kind: 'note', message: 'hi' },
      { kind: 'mkdir', path: '/x' },
    ];
    expect(changeCount(actions)).toBe(1);
    expect(changeCount([])).toBe(0);
  });

  it('says when a plan has nothing to change', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await expect(
      confirmAndApply(app.runtime, [{ kind: 'note', message: 'only a note' }], []),
    ).resolves.toBeNull();
    expect(env.host.infos).toStrictEqual(['Nothing to change.']);
    expect(env.host.opened).toStrictEqual([]);
  });

  it('reports the step a plan stopped at', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    const victim = await writeText(path.join(env.home, 'keep.txt'), 'keep\n');
    const deps = applyDeps(app.runtime);
    expect(deps.platform).toBe('linux');
    expect(deps.now().getTime()).toBe(app.runtime.clock());
    expect(deps.paths).toBe(env.paths);
    const result = await applyPlan([{ kind: 'remove', path: victim }], deps);
    expect(reportApply(app.runtime, result)).toBe(false);
    expect(env.host.errors).toStrictEqual([
      `Stopped at "remove ~/keep.txt (backed up first)": Refusing to replace ${victim}: it was not backed up first`,
    ]);
    expect(reportApply(app.runtime, { backupDir: null, performed: [], failed: null })).toBe(true);
    expect(env.host.infos).toStrictEqual(['Applied 0 changes.']);
  });
});

describe('memory projects', () => {
  it('joins ~/.claude.json projects with store sessions, once per project dir', async () => {
    const env = await makeEnv();
    await writeJson(env.paths.claudeJson, { projects: { '/a': {}, '/b': {}, '': {} } });
    const { app, bus } = makeApp(env);
    bus.emit('session.upserted', session('s1', { cwd: '/a' }));
    bus.emit('session.upserted', session('s2', { cwd: '/c' }));
    bus.emit('session.upserted', session('s3', { cwd: '' }));
    const projects = await memoryProjects(app.runtime);
    expect(projects).toStrictEqual([
      { projectDir: path.join(env.paths.projectsDir, '-a'), cwd: '/a' },
      { projectDir: path.join(env.paths.projectsDir, '-b'), cwd: '/b' },
      { projectDir: path.join(env.paths.projectsDir, '-c'), cwd: '/c' },
    ]);
  });

  it('reads no projects from a ~/.claude.json without them', async () => {
    const env = await makeEnv();
    await writeJson(env.paths.claudeJson, { projects: [] });
    const { app } = makeApp(env);
    await expect(memoryProjects(app.runtime)).resolves.toStrictEqual([]);
    await writeJson(env.paths.claudeJson, []);
    await expect(memoryProjects(app.runtime)).resolves.toStrictEqual([]);
  });

  it('runs only when the manifest turns memory on', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec, {
      'overlord.json': '{"version":1,"memory":{"enabled":false}}\n',
    });
    const { app } = makeApp(env, { deps: { exec } });
    await expect(runMemorySync(app.runtime, repo)).resolves.toBeNull();
    await writeText(path.join(repo, 'overlord.json'), '{"version":1}\n');
    await expect(runMemorySync(app.runtime, repo)).resolves.toStrictEqual({
      synced: [],
      skipped: [],
    });
    expect(env.host.warnings).toStrictEqual([]);
  });
});
