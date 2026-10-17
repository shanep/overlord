// Uses a temp home from makeEnv, so nothing touches the real ~/.claude.
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AutoApproveRule } from '../../../shared/rules.js';
import type { Runtime } from '../runtime.js';
import type { TestEnv } from '../test-helpers/fixtures.js';
import { makeApp, makeEnv, NOW, waitFor, writeJson, writeText } from '../test-helpers/fixtures.js';

import {
  buildMessages,
  cachedMessages,
  EMPTY_MESSAGES,
  refreshMessages,
  sendMessageRules,
  STALE_MS,
} from './messages.js';

interface Harness {
  readonly rt: Runtime;
  readonly env: TestEnv;
  readonly notified: () => number;
  readonly reports: string[];
  readonly setNow: (value: number) => void;
}

async function harness(): Promise<Harness> {
  const env = await makeEnv({ workspace: true });
  const { app } = makeApp(env);
  let notified = 0;
  let now = NOW;
  const reports: string[] = [];
  const rt: Runtime = {
    ...app.runtime,
    clock: (): number => now,
    notify: (): void => {
      notified += 1;
    },
    report: (source, message): void => {
      reports.push(`${source}: ${message}`);
    },
  };
  return {
    rt,
    env,
    notified: (): number => notified,
    reports,
    setNow: (value): void => {
      now = value;
    },
  };
}

function sendLine(id: string, to: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${id}`,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: 'synthetic' } }],
    },
  });
}

function rule(id: string, tool: string): AutoApproveRule {
  return { id, enabled: true, behavior: 'deny', tool, pattern: null, description: '' };
}

describe('sendMessageRules', () => {
  it('keeps rules whose tool pattern covers SendMessage, enabled or not', () => {
    const rules = [
      rule('a', 'SendMessage'),
      rule('b', 'Bash'),
      { ...rule('c', '*'), enabled: false },
      rule('d', 'Send*'),
    ];
    expect(sendMessageRules(rules).map((item) => item.id)).toStrictEqual(['a', 'c', 'd']);
  });
});

describe('buildMessages', () => {
  it('answers at once, then fills in from a background scan', async () => {
    const { rt, env, notified } = await harness();
    await writeText(
      path.join(env.paths.projectsDir, '-w', 's1.jsonl'),
      `${sendLine('t1', 'other-session')}\n`,
    );
    await writeJson(env.paths.userSettings, { crossSessionInbound: 'hold' });
    const first = buildMessages(rt);
    expect(first).toStrictEqual({
      ...EMPTY_MESSAGES,
      inboundChoices: ['accept', 'hold', 'refuse'],
    });
    await waitFor(() => notified() === 1);
    const filled = buildMessages(rt);
    expect(filled.messages.map((message) => message.id)).toStrictEqual(['s1:t1']);
    expect(filled.routes).toMatchObject([{ from: 'Session s1', to: 'other-session', count: 1 }]);
    expect(filled.inboundPolicy).toBe('hold');
    expect(cachedMessages(rt)).toStrictEqual({ ...filled, rules: [] });
  });

  it('reads the workspace settings too', async () => {
    const { rt, env, notified } = await harness();
    const workspace = env.host.workspaceFolder() ?? '';
    await writeJson(path.join(workspace, '.claude', 'settings.json'), {
      crossSessionInbound: 'refuse',
    });
    buildMessages(rt);
    await waitFor(() => notified() === 1);
    expect(buildMessages(rt).inboundPolicy).toBe('refuse');
  });

  it('rescans only once the cache is stale', async () => {
    const { rt, notified, setNow } = await harness();
    buildMessages(rt);
    buildMessages(rt);
    await waitFor(() => notified() === 1);
    setNow(NOW + STALE_MS - 1);
    buildMessages(rt);
    await refreshMessages(rt);
    expect(notified()).toBe(2);
    setNow(NOW + 2 * STALE_MS);
    buildMessages(rt);
    await waitFor(() => notified() === 3);
    expect(STALE_MS).toBe(30_000);
  });

  it('lists the current SendMessage rules on every build', async () => {
    const { rt } = await harness();
    await rt.permissions.saveRule(rule('deny-peers', 'SendMessage'));
    await rt.permissions.saveRule(rule('deny-bash', 'Bash'));
    expect(buildMessages(rt).rules.map((item) => item.id)).toStrictEqual(['deny-peers']);
  });

  it('keeps one cache per runtime', async () => {
    const one = await harness();
    const two = await harness();
    await writeText(
      path.join(one.env.paths.projectsDir, '-w', 's1.jsonl'),
      `${sendLine('t1', 'a1')}\n`,
    );
    await refreshMessages(one.rt);
    await refreshMessages(two.rt);
    expect(cachedMessages(one.rt).messages).toHaveLength(1);
    expect(cachedMessages(two.rt).messages).toHaveLength(0);
  });

  it('reports a scan that fails and still tells the panels', async () => {
    const { rt, env, notified, reports } = await harness();
    const project = path.join(env.paths.projectsDir, '-w');
    await mkdir(path.join(env.root, 'a-folder'), { recursive: true });
    await mkdir(project, { recursive: true });
    await symlink(path.join(env.root, 'a-folder'), path.join(project, 'broken.jsonl'));
    await refreshMessages(rt);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/^messages: /u);
    expect(notified()).toBe(1);
    expect(cachedMessages(rt).messages).toStrictEqual([]);
  });

  it('runs a requested refresh after the one already running', async () => {
    const { rt, notified } = await harness();
    buildMessages(rt);
    await Promise.all([refreshMessages(rt), refreshMessages(rt)]);
    expect(notified()).toBe(3);
    buildMessages(rt);
    expect(notified()).toBe(3);
  });
});
