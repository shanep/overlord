import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { LaunchSpec } from '../../shared/model.js';
import type { WebviewAction } from '../../shared/protocol.js';
import { isWebviewToHost } from '../../shared/protocol.js';
import type { ExecResult } from '../sync/exec.js';

import { NOT_LOCAL, SDK_ONLY, sdkTarget } from './actions-session.js';
import type { TestApp, TestEnv } from './test-helpers/fixtures.js';
import {
  makeApp,
  makeEnv,
  ok,
  session,
  settle,
  waitFor,
  writeJson,
  writeText,
} from './test-helpers/fixtures.js';

const SPEC: LaunchSpec = {
  prompt: 'do it',
  cwd: '/repo',
  profileId: null,
  worktree: false,
  maxBudgetUsd: null,
  label: 'one',
};

async function registry(env: TestEnv, entry: Record<string, unknown>): Promise<void> {
  await writeJson(path.join(env.paths.sessionsDir, `${String(entry['pid'])}.json`), entry);
}

function liveApp(env: TestEnv, agentsJson = '[]'): TestApp {
  return makeApp(env, {
    deps: { isAlive: (pid) => pid === 123 },
    responders: [
      (call): ExecResult | undefined => (call.args[0] === 'agents' ? ok(agentsJson) : undefined),
    ],
  });
}

async function launched(test: TestApp): Promise<string> {
  test.app.runtime.launcher.launch([SPEC], []);
  await waitFor(() => test.queries.queries.length === 1);
  const sessionId = test.app.runtime.launcher.runs()[0]?.sessionId ?? null;
  if (sessionId === null) {
    throw new Error('the run has no session');
  }
  return sessionId;
}

function parsedAction(message: unknown): WebviewAction {
  if (!isWebviewToHost(message) || message.type !== 'action') {
    throw new Error('not an action message');
  }
  return message.action;
}

describe('opening panels and files', () => {
  it('opens the agent panel, the context panel and files', async () => {
    const env = await makeEnv();
    const { app, bus } = makeApp(env);
    bus.emit('session.upserted', session('s'));
    await app.dispatch({ type: 'openAgent', sessionId: 's', agentId: 'a' }, {});
    await app.dispatch({ type: 'openContext', sessionId: 's', agentId: null }, {});
    await app.dispatch({ type: 'openContext', sessionId: 's', agentId: 'a' }, {});
    await app.dispatch({ type: 'openFile', path: '/f.md' }, {});
    expect(env.host.panels).toStrictEqual([
      { view: 'agent', params: { sessionId: 's', agentId: 'a' } },
      { view: 'context', params: { sessionId: 's' } },
      { view: 'context', params: { sessionId: 's', agentId: 'a' } },
    ]);
    expect(env.host.opened).toStrictEqual(['/f.md']);
  });
});

describe('opening an old session', () => {
  it('loads a transcript the store has not seen before opening the panel', async () => {
    const env = await makeEnv();
    await writeText(
      path.join(env.paths.projectsDir, '-old', 'old-1.jsonl'),
      `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'old-1', cwd: '/old', timestamp: '2020-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } })}\n`,
    );
    const { app } = makeApp(env);
    await app.start();
    onTestFinished(async () => {
      await app.dispose();
    });
    await app.dispatch({ type: 'openAgent', sessionId: 'old-1', agentId: 'old-1' }, {});
    expect(env.host.panels).toStrictEqual([
      { view: 'agent', params: { sessionId: 'old-1', agentId: 'old-1' } },
    ]);
    const detail = app.stateFor('agent', { sessionId: 'old-1', agentId: 'old-1' });
    expect(detail.view === 'agent' ? detail.state.session?.cwd : null).toBe('/old');
  });

  it('says so when there is no transcript, before and after start', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'openAgent', sessionId: 'nope-1234567', agentId: 'x' }, {});
    await app.start();
    onTestFinished(async () => {
      await app.dispose();
    });
    await app.dispatch({ type: 'openAgent', sessionId: 'nope-1234567', agentId: 'x' }, {});
    expect(env.host.panels).toStrictEqual([]);
    expect(env.host.infos).toStrictEqual([
      'No transcript found for session nope-123.',
      'No transcript found for session nope-123.',
    ]);
  });
});

describe('SDK sessions Overlord launched', () => {
  it('finds the live SDK session behind a session id', async () => {
    const env = await makeEnv();
    const test = makeApp(env);
    expect(sdkTarget(test.app.runtime, 'nope')).toBeNull();
    const sessionId = await launched(test);
    expect(sdkTarget(test.app.runtime, sessionId)?.run.spec).toStrictEqual(SPEC);
  });

  it('interrupts, changes model and mode, and stops through the SDK', async () => {
    const env = await makeEnv();
    const test = makeApp(env);
    const sessionId = await launched(test);
    const query = test.queries.queries[0];
    await test.app.dispatch({ type: 'interrupt', sessionId }, {});
    await test.app.dispatch({ type: 'setModel', sessionId, model: 'opus' }, {});
    await test.app.dispatch({ type: 'setPermissionMode', sessionId, mode: 'manual' }, {});
    await test.app.dispatch({ type: 'setPermissionMode', sessionId, mode: 'nope' }, {});
    expect(query?.interrupts).toBe(1);
    expect(query?.models).toStrictEqual(['opus']);
    expect(query?.modes).toStrictEqual(['default']);
    expect(env.host.infos).toStrictEqual([
      'Model set to opus.',
      'Permission mode set to manual.',
      'Unknown permission mode "nope".',
    ]);
    await test.app.dispatch({ type: 'stop', sessionId }, {});
    await waitFor(() => test.app.runtime.launcher.runs()[0]?.state === 'stopped');
    expect(sdkTarget(test.app.runtime, sessionId)).toBeNull();
    expect(env.host.questions).toStrictEqual([]);
    expect(test.kills).toStrictEqual([]);
  });
});

describe('other local sessions', () => {
  it('signals a live process only after the user agrees', async () => {
    const env = await makeEnv();
    await registry(env, { pid: 123, sessionId: 'live-session', cwd: '/live' });
    const test = liveApp(env);
    env.host.confirmAnswers.push(true, false, true);
    await test.app.dispatch({ type: 'interrupt', sessionId: 'live-session' }, {});
    await test.app.dispatch({ type: 'interrupt', sessionId: 'live-session' }, {});
    await test.app.dispatch({ type: 'stop', sessionId: 'live-session' }, {});
    expect(env.host.questions).toStrictEqual([
      { message: 'Interrupt Claude session live-ses (pid 123)?', action: 'Interrupt' },
      { message: 'Interrupt Claude session live-ses (pid 123)?', action: 'Interrupt' },
      { message: 'Stop Claude session live-ses (pid 123)?', action: 'Stop' },
    ]);
    expect(test.kills).toStrictEqual([
      { pid: 123, signal: 'SIGINT' },
      { pid: 123, signal: 'SIGTERM' },
    ]);
    const claudeCall = test.calls.find((call) => call.command === 'claude');
    expect(claudeCall?.args).toStrictEqual(['agents', '--json']);
    expect(claudeCall?.options).toStrictEqual({ timeoutMs: 5000 });
  });

  it('says so when the session is not running here', async () => {
    const env = await makeEnv();
    await registry(env, { pid: 999, sessionId: 'dead', cwd: '/x' });
    await writeJson(path.join(env.paths.sessionsDir, 'bad.json'), { nope: true });
    const test = liveApp(env, JSON.stringify([{ sessionId: 'no-pid' }]));
    await test.app.dispatch({ type: 'stop', sessionId: 'dead' }, {});
    await test.app.dispatch({ type: 'interrupt', sessionId: 'unknown' }, {});
    await test.app.dispatch({ type: 'interrupt', sessionId: 'no-pid' }, {});
    expect(env.host.infos).toStrictEqual([NOT_LOCAL, NOT_LOCAL, NOT_LOCAL]);
    expect(test.kills).toStrictEqual([]);
    expect(env.host.questions).toStrictEqual([]);
  });

  it('cannot change model or mode of a session it did not launch', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'setModel', sessionId: 'x', model: 'opus' }, {});
    await app.dispatch({ type: 'setPermissionMode', sessionId: 'x', mode: 'plan' }, {});
    expect(env.host.infos).toStrictEqual([SDK_ONLY, SDK_ONLY]);
    expect(SDK_ONLY).toBe(
      'Only sessions Overlord launched can change model or permission mode while they run.',
    );
  });
});

describe('attach', () => {
  it('attaches to a background agent by its agent id', async () => {
    const env = await makeEnv();
    await registry(env, { pid: 123, sessionId: 'bg', cwd: '/bg', kind: 'bg' });
    const agents = JSON.stringify([{ id: 'agent-7', sessionId: 'bg', kind: 'background' }]);
    const test = liveApp(env, agents);
    env.host.settings = { ...env.host.settings, claudePath: '/opt/claude' };
    await test.app.dispatch({ type: 'attach', sessionId: 'bg' }, {});
    expect(env.host.terminals).toStrictEqual([
      { name: 'Claude bg', command: '/opt/claude', args: ['attach', 'agent-7'], cwd: '/bg' },
    ]);
  });

  it('attaches by session id when the background agent id is unknown', async () => {
    const env = await makeEnv();
    await registry(env, { pid: 123, sessionId: 'bg2', cwd: '/bg', kind: 'bg' });
    const test = liveApp(env);
    await test.app.dispatch({ type: 'attach', sessionId: 'bg2' }, {});
    expect(env.host.terminals[0]?.args).toStrictEqual(['attach', 'bg2']);
  });

  it('resumes other sessions in the best known folder', async () => {
    const env = await makeEnv({ workspace: true });
    await registry(env, { pid: 123, sessionId: 'inter', cwd: '/inter', kind: 'interactive' });
    const test = liveApp(env);
    test.bus.emit('session.upserted', session('stored', { cwd: '/stored' }));
    await test.app.dispatch({ type: 'attach', sessionId: 'inter' }, {});
    await test.app.dispatch({ type: 'attach', sessionId: 'stored' }, {});
    await test.app.dispatch({ type: 'attach', sessionId: 'gone' }, {});
    env.host.workspace = null;
    await test.app.dispatch({ type: 'attach', sessionId: 'gone' }, {});
    expect(env.host.terminals.map((terminal) => [terminal.args, terminal.cwd])).toStrictEqual([
      [['--resume', 'inter'], '/inter'],
      [['--resume', 'stored'], '/stored'],
      [['--resume', 'gone'], path.join(env.root, 'work')],
      [['--resume', 'gone'], env.home],
    ]);
    expect(env.host.terminals[0]?.command).toBe('claude');
  });
});

describe('handoff', () => {
  it('runs the handoff command for a session in the list', async () => {
    const env = await makeEnv();
    await registry(env, { pid: 123, sessionId: 'local', cwd: '/here', name: 'Mine' });
    const test = liveApp(env);
    await test.app.dispatch({ type: 'handoff', sessionId: 'local', kind: 'resume-local' }, {});
    expect(env.host.terminals).toStrictEqual([
      { name: 'Claude resume-local', command: 'claude', args: ['--resume', 'local'], cwd: '/here' },
    ]);
    const before = test.calls.length;
    await test.app.dispatch({ type: 'handoff', sessionId: 'local', kind: 'start-cloud' }, {});
    expect(test.calls).toHaveLength(before);
    expect(env.host.terminals[1]?.args).toStrictEqual(['--cloud', 'Mine']);
  });

  it('says so when the session or the handoff is not available', async () => {
    const env = await makeEnv();
    await registry(env, { pid: 123, sessionId: 'local', cwd: '/here' });
    const test = liveApp(env);
    await test.app.dispatch({ type: 'handoff', sessionId: 'missing', kind: 'resume-local' }, {});
    await test.app.dispatch({ type: 'handoff', sessionId: 'local', kind: 'teleport-local' }, {});
    expect(env.host.infos).toStrictEqual([
      'That handoff is not available for this session.',
      'That handoff is not available for this session.',
    ]);
    expect(env.host.terminals).toStrictEqual([]);
  });

  it('uses the session cwd fallback for rows without one', async () => {
    const env = await makeEnv();
    await registry(env, { pid: 123, sessionId: 'nocwd' });
    const test = liveApp(env);
    await test.app.dispatch({ type: 'handoff', sessionId: 'nocwd', kind: 'resume-local' }, {});
    expect(env.host.terminals[0]?.cwd).toBe(env.home);
  });
});

describe('dispatch', () => {
  it('answers an unknown action with a message', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    const message: unknown = { type: 'action', action: { type: 'selfDestruct' } };
    const action = parsedAction(message);
    await app.dispatch(action, {});
    expect(env.host.infos).toStrictEqual(['Overlord does not know the action "selfDestruct".']);
  });

  it('shows a handler failure as an error instead of throwing', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    const message: unknown = { type: 'action', action: { type: 'launch' } };
    await app.dispatch(parsedAction(message), {});
    await settle();
    expect(env.host.errors).toHaveLength(1);
  });
});
