// A custom ACP agent from overlord.customAgents, backed by the fake ACP agent,
// run end to end through the Launcher: it shows up as an agent, its session
// reaches the Fleet, its approval reaches the inbox, and interrupt ends its turn.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { LaunchSpec } from '../../shared/model.js';
import { parseCustomAgents } from '../agents/custom.js';
import { agents } from '../agents/index.js';

import { makeApp, makeEnv, waitFor, type TestApp } from './test-helpers/fixtures.js';

const FAKE_DIR = fileURLToPath(new URL('../../../test/fake-agents/acp/', import.meta.url));
const FAKE = path.join(FAKE_DIR, 'fake-acp.mjs');
const TIMEOUT = 20_000;
const WAIT_MS = 10_000;
const SECRET = 'sk-not-for-logs';

function fakeEntry(script: string): Record<string, unknown> {
  return {
    id: 'fake',
    name: 'Fake ACP',
    command: process.execPath,
    args: [FAKE],
    env: {
      FAKE_ACP_SCRIPT: path.join(FAKE_DIR, 'scripts', `${script}.jsonl`),
      FAKE_API_KEY: SECRET,
    },
    icon: 'robot',
  };
}

async function fakeApp(raw: unknown): Promise<TestApp> {
  const env = await makeEnv({
    settings: { customAgents: parseCustomAgents(raw, agents.builtInIds()) },
  });
  return makeApp(env);
}

function spec(cwd: string): LaunchSpec {
  return {
    agent: 'fake',
    prompt: 'Fix calc.py',
    cwd,
    profileId: null,
    worktree: false,
    maxBudgetUsd: null,
    label: 'fix',
  };
}

/** Launches a run of the fake agent and waits for its approval to reach the inbox. */
async function launchToApproval(test: TestApp): Promise<string> {
  const { app } = test;
  await app.dispatch({ type: 'launch', specs: [spec(test.env.root)] }, {});
  await waitFor(() => app.runtime.permissions.inbox.list().length === 1, WAIT_MS);
  const [request] = app.runtime.permissions.inbox.list();
  expect(request).toMatchObject({
    sessionId: 'fake-1',
    agent: 'fake',
    toolName: 'edit',
    source: 'runtime',
    input: { path: '/work/repo/calc.py' },
  });
  return request?.id ?? '';
}

describe('custom ACP agents', () => {
  it(
    'show up as an agent the Launcher can run, with the setting name and icon',
    async () => {
      const { app } = await fakeApp([fakeEntry('allow')]);
      await app.runtime.caches.agents.refresh();
      const listed = app.stateFor('launcher', {}).agents.find((agent) => agent.id === 'fake');
      expect(listed).toMatchObject({
        name: 'Fake ACP',
        icon: 'robot',
        installed: true,
        capabilities: { launch: true, approvals: true, interrupt: true, terminal: false },
      });
    },
    TIMEOUT,
  );

  it(
    'runs from the Launcher, shows the session and asks the inbox',
    async () => {
      const test = await fakeApp([fakeEntry('allow')]);
      const { app } = test;
      const requestId = await launchToApproval(test);
      expect(app.runtime.store.fleetState(0).sessions).toContainEqual(
        expect.objectContaining({ id: 'fake-1', agent: 'fake' }),
      );
      await app.dispatch(
        { type: 'resolvePermission', requestId, decision: { behavior: 'allow', ruleId: null } },
        {},
      );
      await waitFor(() => app.runtime.launcher.runs()[0]?.state === 'done', WAIT_MS);
      expect(app.runtime.launcher.runs()[0]).toMatchObject({
        sessionId: 'fake-1',
        result: 'Done.',
      });
      expect(test.env.host.warnings).toStrictEqual([]);
    },
    TIMEOUT,
  );

  it(
    'interrupts a turn waiting on an approval',
    async () => {
      const test = await fakeApp([fakeEntry('cancel')]);
      const { app } = test;
      await launchToApproval(test);
      await app.dispatch({ type: 'interrupt', sessionId: 'fake-1' }, {});
      await waitFor(() => app.runtime.launcher.runs()[0]?.state === 'failed', WAIT_MS);
      expect(app.runtime.permissions.inbox.list()).toStrictEqual([]);
      expect(test.env.host.infos).not.toContain("Press Esc in the session's tab to interrupt it.");
    },
    TIMEOUT,
  );

  it('skips clashing and broken entries with one warning each, never showing env values', async () => {
    const raw = [
      { id: 'codex', name: 'Not Codex', command: 'codex' },
      { id: 'broken', name: 'Broken', command: 'x', env: { KEY: SECRET, PORT: 1 } },
      fakeEntry('allow'),
    ];
    const test = await fakeApp(raw);
    const { app, env } = test;
    expect(agents.get('fake')?.name).toBe('Fake ACP');
    expect(agents.get('broken')).toBeNull();
    expect(agents.get('codex')?.name).toBe('Codex CLI');
    expect(env.host.warnings).toStrictEqual([
      'overlord.customAgents entry 1 ("codex") has the id of a built-in agent, so Overlord skipped it.',
      'overlord.customAgents entry 2 ("broken") has an env whose values are not all strings, so Overlord skipped it.',
    ]);
    // A settings change applies the new list and does not repeat old warnings.
    app.applySettings();
    expect(env.host.warnings).toHaveLength(2);
    env.host.settings = {
      ...env.host.settings,
      customAgents: parseCustomAgents([], agents.builtInIds()),
    };
    app.applySettings();
    expect(agents.get('fake')).toBeNull();
    expect(env.host.warnings.join('\n')).not.toContain(SECRET);
  });
});
