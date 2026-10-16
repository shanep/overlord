import { describe, expect, it } from 'vitest';

import type { LaunchProfile, LaunchSpec, PermissionDecision } from '../../shared/model.js';
import type { AutoApproveRule } from '../../shared/protocol.js';

import { CONFIRM_ABOVE_USD, defaultModel } from './actions-launch.js';
import {
  makeApp,
  makeEnv,
  permissionRequest,
  waitFor,
  writeJson,
} from './test-helpers/fixtures.js';

function spec(label: string, overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    prompt: 'hi',
    cwd: '/repo',
    profileId: null,
    worktree: false,
    maxBudgetUsd: null,
    label,
    ...overrides,
  };
}

function specs(count: number, overrides: Partial<LaunchSpec> = {}): LaunchSpec[] {
  return Array.from({ length: count }, (_unused, index) => spec(`run ${String(index)}`, overrides));
}

const PROFILE: LaunchProfile = {
  id: 'cheap',
  name: 'Cheap',
  model: 'haiku',
  effort: null,
  permissionMode: null,
  env: {},
  extraArgs: [],
};

const RULE: AutoApproveRule = {
  id: 'r1',
  enabled: true,
  behavior: 'allow',
  tool: 'Read',
  pattern: null,
  description: 'reads are fine',
};

describe('permission actions', () => {
  it('answers a waiting request and says when none is waiting', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    const answer = app.runtime.permissions.inbox.request(
      permissionRequest('p1'),
      new AbortController().signal,
    );
    const decision: PermissionDecision = { behavior: 'allow', ruleId: null };
    await app.dispatch({ type: 'resolvePermission', requestId: 'p1', decision }, {});
    await expect(answer).resolves.toStrictEqual(decision);
    expect(env.host.infos).toStrictEqual([]);
    await app.dispatch({ type: 'resolvePermission', requestId: 'p1', decision }, {});
    expect(env.host.infos).toStrictEqual(['That request is no longer waiting.']);
  });

  it('always allows a request, or explains why it could not remember it', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    const { permissions } = app.runtime;
    void permissions.inbox.request(permissionRequest('p1'), new AbortController().signal);
    await app.dispatch({ type: 'alwaysAllowPermission', requestId: 'p1' }, {});
    expect(permissions.rules()).toMatchObject([{ id: 'allow-p1', tool: 'Bash', pattern: 'ls' }]);
    expect(env.host.infos).toStrictEqual([]);
    void permissions.inbox.request(
      permissionRequest('p2', { input: { command: 'ls | wc' } }),
      new AbortController().signal,
    );
    await app.dispatch({ type: 'alwaysAllowPermission', requestId: 'p2' }, {});
    await app.dispatch({ type: 'alwaysAllowPermission', requestId: 'p2' }, {});
    expect(env.host.infos).toStrictEqual([
      'Allowed once. Overlord only remembers a plain command, with no chaining, pipes, redirects or backslashes, so this one will ask again.',
      'That request is no longer waiting.',
    ]);
  });

  it('saves, validates and deletes rules', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'saveRule', rule: { ...RULE, tool: '' } }, {});
    expect(env.host.errors).toStrictEqual(['That rule is not valid.']);
    expect(app.runtime.permissions.rules()).toStrictEqual([]);
    await app.dispatch({ type: 'saveRule', rule: RULE }, {});
    expect(app.runtime.permissions.rules()).toStrictEqual([RULE]);
    expect(app.stateFor('launcher', {})).toMatchObject({ state: { rules: [RULE] } });
    await app.dispatch({ type: 'deleteRule', ruleId: 'r1' }, {});
    expect(app.runtime.permissions.rules()).toStrictEqual([]);
    expect(env.host.infos).toStrictEqual([]);
    await app.dispatch({ type: 'deleteRule', ruleId: 'r1' }, {});
    expect(env.host.infos).toStrictEqual(['That rule is already gone.']);
  });
});

describe('launch', () => {
  it('needs at least one spec', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'launch', specs: [] }, {});
    expect(env.host.infos).toStrictEqual(['Nothing to launch.']);
    expect(app.runtime.launcher.runs()).toStrictEqual([]);
  });

  it('starts a cheap batch without asking', async () => {
    const env = await makeEnv();
    const { app, queries } = makeApp(env);
    await app.dispatch({ type: 'launch', specs: [spec('one')] }, {});
    expect(env.host.questions).toStrictEqual([]);
    expect(env.host.infos).toStrictEqual(['Queued 1 run.']);
    expect(app.runtime.launcher.runs().map((run) => run.spec.label)).toStrictEqual(['one']);
    await waitFor(() => queries.queries[0]?.prompts.length === 1);
    expect(queries.queries[0]?.prompts).toStrictEqual(['hi']);
  });

  it('asks before a batch that may cost more than a dollar', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    expect(CONFIRM_ABOVE_USD).toBe(1);
    await app.dispatch({ type: 'launch', specs: specs(12) }, {});
    expect(env.host.questions).toStrictEqual([
      { message: 'These 12 runs may cost about $1.20. Launch them?', action: 'Launch' },
    ]);
    expect(app.runtime.launcher.runs()).toStrictEqual([]);
    env.host.confirmAnswers.push(true);
    await app.dispatch({ type: 'launch', specs: specs(12) }, {});
    expect(app.runtime.launcher.runs()).toHaveLength(12);
    expect(env.host.infos).toStrictEqual(['Queued 12 runs.']);
  });

  it('runs an empty folder in the workspace folder, or home when there is none', async () => {
    const env = await makeEnv({ workspace: true });
    const { app } = makeApp(env);
    const workspace = env.host.workspaceFolder() ?? '';
    expect(app.stateFor('launcher', {})).toMatchObject({ state: { defaultFolder: workspace } });
    await app.dispatch({ type: 'launch', specs: [spec('empty', { cwd: '' }), spec('set')] }, {});
    expect(app.runtime.launcher.runs().map((run) => run.spec.cwd)).toStrictEqual([
      workspace,
      '/repo',
    ]);
    const bare = await makeEnv();
    expect(makeApp(bare).app.stateFor('launcher', {})).toMatchObject({
      state: { defaultFolder: bare.home },
    });
  });

  it('prices runs by their profile model', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'saveProfile', profile: PROFILE }, {});
    await app.dispatch({ type: 'launch', specs: specs(12, { profileId: 'cheap' }) }, {});
    expect(env.host.questions).toStrictEqual([]);
    expect(app.runtime.launcher.runs()).toHaveLength(12);
    expect(app.stateFor('knobs', {})).toMatchObject({ state: { profiles: [PROFILE] } });
  });

  it('uses the model setting as the default model', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    expect(defaultModel(app.runtime)).toBe('claude-opus-5-5');
    await writeJson(env.paths.userSettings, { model: 'claude-fable-5-1' });
    await app.runtime.caches.knobs.refresh();
    expect(defaultModel(app.runtime)).toBe('claude-fable-5-1');
    await app.dispatch({ type: 'launch', specs: specs(4) }, {});
    expect(env.host.questions[0]?.message).toBe('These 4 runs may cost about $1.00. Launch them?');
    await writeJson(env.paths.userSettings, { model: '' });
    await app.runtime.caches.knobs.refresh();
    expect(defaultModel(app.runtime)).toBe('claude-opus-5-5');
    await writeJson(env.paths.userSettings, { model: 5 });
    await app.runtime.caches.knobs.refresh();
    expect(defaultModel(app.runtime)).toBe('claude-opus-5-5');
  });
});

describe('stopping runs', () => {
  it('stops one run, all runs, and says when there is nothing to stop', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'stopAll' }, {});
    await app.dispatch({ type: 'stopRun', runId: 'nope' }, {});
    expect(env.host.infos).toStrictEqual(['Nothing is running.', 'That run already finished.']);
    env.host.infos.length = 0;
    await app.dispatch({ type: 'launch', specs: specs(3) }, {});
    const [first] = app.runtime.launcher.runs();
    await app.dispatch({ type: 'stopRun', runId: first?.id ?? '' }, {});
    await app.dispatch({ type: 'stopAll' }, {});
    expect(env.host.infos).toStrictEqual(['Queued 3 runs.', 'Stopped 2 runs.']);
    await waitFor(() => app.runtime.launcher.runs().every((run) => run.state === 'stopped'));
  });
});

describe('profiles', () => {
  it('shows why a profile was not saved', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'saveProfile', profile: { ...PROFILE, name: '' } }, {});
    expect(env.host.errors).toHaveLength(1);
    expect(env.host.errors[0]).toMatch(/^Invalid profile: /u);
    expect(app.runtime.caches.profiles.peek()).toStrictEqual([]);
  });
});
