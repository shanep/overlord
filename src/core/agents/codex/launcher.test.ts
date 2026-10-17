// A Launcher run with a Codex profile, end to end over the fake app-server:
// the session shows up under the id Codex mints, the feed, usage and limits
// reach the bus, and the approval goes through the permission inbox and back.

import { describe, expect, it, vi } from 'vitest';

import {
  FakeAppServer,
  loadRecording,
  type Recorded,
} from '../../../../test/fake-agents/codex/fake-app-server.js';
import { interruptedApproval, THREAD_ID } from '../../../../test/fake-agents/codex/scenarios.js';
import type {
  FeedItem,
  LaunchProfile,
  LaunchSpec,
  PermissionRequest,
} from '../../../shared/model.js';
import { EventBus, type OverlordEvents } from '../../bus.js';
import { PermissionInbox } from '../../harness/inbox.js';
import { Launcher } from '../../harness/launcher.js';
import { AgentRegistry } from '../registry.js';

import { codexRuntime } from './runtime.js';

import { codex } from './index.js';

const RECORDED_THREAD = '01a1480b-e3ce-72c0-a983-d84252bd9063';

const PROFILE: LaunchProfile = {
  id: 'codex-low',
  agent: 'codex',
  name: 'Codex low',
  model: null,
  effort: 'low',
  permissionMode: 'untrusted/read-only',
  env: { FROM_PROFILE: 'yes' },
  extraArgs: [],
};

const SPEC: LaunchSpec = {
  prompt: 'Run touch approved.txt',
  cwd: '/work/repo',
  profileId: PROFILE.id,
  worktree: false,
  maxBudgetUsd: null,
  label: 'touch',
};

interface Setup {
  readonly launcher: Launcher;
  readonly inbox: PermissionInbox;
  readonly server: FakeAppServer;
  readonly seen: { readonly [K in keyof OverlordEvents]?: OverlordEvents[K][] };
}

function setup(recording: readonly Recorded[]): Setup {
  const server = new FakeAppServer(recording);
  const bus = new EventBus();
  const seen: Record<string, unknown[]> = {};
  const names = [
    'session.upserted',
    'feed.appended',
    'request.recorded',
    'rateLimits.updated',
    'permission.requested',
  ] as const;
  for (const name of names) {
    bus.on(name, (payload) => {
      const list = seen[name] ?? [];
      list.push(payload);
      seen[name] = list;
    });
  }
  const inbox = new PermissionInbox({ bus });
  const launcher = new Launcher(
    {
      agents: new AgentRegistry([{ ...codex, runtime: codexRuntime(server.spawn) }]),
      bus,
      broker: inbox,
      baseEnv: async (): Promise<Record<string, string>> => {
        await Promise.resolve();
        return { PATH: '/usr/bin' };
      },
    },
    2,
  );
  launcher.launch([SPEC], [PROFILE]);
  return { launcher, inbox, server, seen };
}

async function asked(inbox: PermissionInbox): Promise<PermissionRequest> {
  await vi.waitFor(() => {
    expect(inbox.list()).toHaveLength(1);
  });
  const [request] = inbox.list();
  if (request === undefined) {
    throw new Error('no request');
  }
  return request;
}

describe('a Launcher run on a Codex profile', () => {
  it('shows the late session, its feed, usage and limits, and sends the answer back', async () => {
    const { launcher, inbox, server, seen } = setup(loadRecording());
    const request = await asked(inbox);
    expect(request).toMatchObject({
      sessionId: RECORDED_THREAD,
      agent: 'codex',
      agentId: RECORDED_THREAD,
      toolName: 'exec_command',
      input: { command: 'touch approved.txt', cwd: '/work/repo' },
      source: 'runtime',
      choices: ['allow', 'deny', 'cancel'],
    });
    expect(launcher.runs()[0]).toMatchObject({ state: 'running', sessionId: RECORDED_THREAD });
    inbox.resolve(request.id, { behavior: 'deny', message: 'not now', ruleId: null });
    await launcher.idle();

    expect(server.replies()).toStrictEqual([{ decision: 'decline' }]);
    expect(launcher.runs()[0]).toMatchObject({
      state: 'done',
      sessionId: RECORDED_THREAD,
      result: 'declined',
      durationMs: 3988,
    });
    const [launch] = server.launches;
    expect(launch?.args).toStrictEqual(['app-server', '-c', 'model_reasoning_effort="low"']);
    expect(launch?.env).toMatchObject({ PATH: '/usr/bin', FROM_PROFILE: 'yes' });
    expect(server.sent('thread/start')).toStrictEqual([
      { cwd: '/work/repo', approvalPolicy: 'untrusted', sandbox: 'read-only' },
    ]);

    const sessions = seen['session.upserted'] ?? [];
    expect(sessions.every((session) => session.id === RECORDED_THREAD)).toBe(true);
    expect(sessions.at(-1)).toMatchObject({
      agent: 'codex',
      model: 'gpt-6-luna',
      permissionMode: 'untrusted/read-only',
      version: '0.163.0',
      state: 'done',
      usage: { input: 2638, output: 75, cacheRead: 24_064 },
    });
    const feed: FeedItem[] = (seen['feed.appended'] ?? []).flatMap((entry) => entry.items);
    expect(feed.map((entry) => entry.kind)).toStrictEqual([
      'user',
      'system',
      'tool_use',
      'tool_result',
      'text',
    ]);
    expect(feed.at(-1)).toMatchObject({ kind: 'text', text: 'declined' });
    expect((seen['request.recorded'] ?? []).map((call) => call.messageId)).toStrictEqual([
      '01a1480b-e400-7c31-8d38-eddcbd29aef2:1',
      '01a1480b-e400-7c31-8d38-eddcbd29aef2:2',
    ]);
    expect(seen['rateLimits.updated']?.at(-1)?.windows).toStrictEqual([
      { agent: 'codex', id: 'primary', label: '30 day', usedPct: 0, resetsAt: 1_794_802_006_000 },
    ]);
    expect(seen['permission.requested']).toHaveLength(1);
  });

  it('interrupts a turn that waits on the inbox and clears the prompt', async () => {
    const { launcher, inbox, server } = setup(interruptedApproval());
    await asked(inbox);
    const run = launcher.runs()[0];
    expect(run?.sessionId).toBe(THREAD_ID);
    await launcher.session(run?.id ?? '')?.interrupt();
    await launcher.idle();
    expect(inbox.list()).toStrictEqual([]);
    expect(server.sent('turn/interrupt')).toHaveLength(1);
    expect(launcher.runs()[0]).toMatchObject({ state: 'failed' });
  });

  it('kills the app-server when the run is stopped', async () => {
    const { launcher, inbox, server } = setup(interruptedApproval());
    await asked(inbox);
    expect(launcher.stopAll()).toBe(1);
    await launcher.idle();
    expect(server.killed).toBe(1);
    expect(inbox.list()).toStrictEqual([]);
    expect(launcher.runs()[0]).toMatchObject({ state: 'stopped' });
  });
});
