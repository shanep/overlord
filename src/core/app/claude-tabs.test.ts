import { describe, expect, it } from 'vitest';

import type { ExecResult } from '../sync/exec.js';

import { openClaudeTab, READY_DELAY_MS, READY_TRIES } from './claude-tabs.js';
import type { Responder, TestApp } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, ok } from './test-helpers/fixtures.js';

const BACKGROUNDED = 'backgrounded · 8c3efb13 (idle, send a prompt to start)\n  claude agents\n';

function background(stdout: string): Responder {
  return (call): ExecResult | undefined => (call.args.includes('--bg') ? ok(stdout) : undefined);
}

function agents(list: readonly unknown[]): Responder {
  return (call): ExecResult | undefined =>
    call.args[0] === 'agents' ? ok(JSON.stringify(list)) : undefined;
}

/** Lists nothing for the first `misses` calls, then the given sessions, like a slow cold start. */
function agentsAfter(misses: number, list: readonly unknown[]): Responder {
  let calls = 0;
  return (call): ExecResult | undefined => {
    if (call.args[0] !== 'agents') {
      return undefined;
    }
    calls += 1;
    return ok(JSON.stringify(calls > misses ? list : []));
  };
}

/** Waits return at once, so a test that polls does not sleep for real. */
const instant = {
  delay: async (): Promise<void> => {
    await Promise.resolve();
  },
};

function bgCall(test: TestApp): readonly string[] | undefined {
  return test.calls.find((call) => call.args.includes('--bg'))?.args;
}

describe('Claude tabs', () => {
  it('starts a new session in the background and attaches the tab to it', async () => {
    const env = await makeEnv();
    const test = makeApp(env, {
      responders: [
        background(BACKGROUNDED),
        agents([{ id: '8c3efb13', sessionId: '8c3efb13-full', kind: 'background' }]),
      ],
    });
    const tab = { name: 'Claude Code', cwd: env.home, resume: null };
    expect(await openClaudeTab(test.app.runtime, tab)).toBe('8c3efb13-full');
    expect(bgCall(test)).toStrictEqual(['--bg']);
    expect(test.calls.find((call) => call.args.includes('--bg'))?.options.cwd).toBe(env.home);
    expect(env.host.terminals).toStrictEqual([
      {
        name: 'Claude Code',
        command: 'claude',
        args: ['attach', '8c3efb13'],
        cwd: env.home,
        sessionId: '8c3efb13-full',
      },
    ]);
    expect(test.app.errorList().map((error) => error.source)).not.toContain('claude tab');
  });

  it('hands variables to the background session as settings', async () => {
    const env = await makeEnv();
    const test = makeApp(env, {
      responders: [
        background(BACKGROUNDED),
        agents([{ id: '8c3efb13', sessionId: '8c3efb13-full', kind: 'background' }]),
      ],
    });
    const tab = { name: 'Claude Code', cwd: env.home, resume: null, env: { OVERLORD_SLOT: '3' } };
    expect(await openClaudeTab(test.app.runtime, tab)).toBe('8c3efb13-full');
    expect(bgCall(test)).toStrictEqual(['--bg', '--settings', '{"env":{"OVERLORD_SLOT":"3"}}']);
  });

  it('waits for a slow session to be listed before attaching, so the tab does not close', async () => {
    const env = await makeEnv();
    const waits: number[] = [];
    const test = makeApp(env, {
      deps: {
        delay: async (ms): Promise<void> => {
          waits.push(ms);
          await Promise.resolve();
        },
      },
      responders: [
        background(BACKGROUNDED),
        agentsAfter(2, [{ id: '8c3efb13', sessionId: '8c3efb13-late', kind: 'background' }]),
      ],
    });
    const tab = { name: 'Claude Code', cwd: env.home, resume: null };
    expect(await openClaudeTab(test.app.runtime, tab)).toBe('8c3efb13-late');
    expect(waits).toStrictEqual([READY_DELAY_MS, READY_DELAY_MS]);
    expect(env.host.terminals).toHaveLength(1);
    expect(env.host.terminals[0]).toMatchObject({
      args: ['attach', '8c3efb13'],
      sessionId: '8c3efb13-late',
    });
  });

  it('opens no tab and says so when the session never becomes ready', async () => {
    const env = await makeEnv();
    const test = makeApp(env, {
      deps: instant,
      responders: [background(BACKGROUNDED), agents([])],
    });
    const tab = { name: 'Claude Code', cwd: env.home, resume: null };
    expect(await openClaudeTab(test.app.runtime, tab)).toBeNull();
    expect(test.calls.filter((call) => call.args[0] === 'agents')).toHaveLength(READY_TRIES);
    expect(READY_TRIES * READY_DELAY_MS).toBe(15_000);
    expect(env.host.terminals).toStrictEqual([]);
    const message =
      'Claude Code started session 8c3efb13 but it did not become ready. Open it from the Fleet in a moment.';
    expect(env.host.warnings).toStrictEqual([message]);
    expect(test.app.errorList().at(-1)?.message).toBe(message);
  });

  it('continues a session in the background under its own id', async () => {
    const env = await makeEnv();
    const test = makeApp(env, {
      responders: [
        background(BACKGROUNDED),
        agents([{ id: '8c3efb13', sessionId: 'listed-under-another-id', kind: 'background' }]),
      ],
    });
    const tab = { name: 'Claude: Mine', cwd: env.home, resume: '8c3efb13-mine' };
    expect(await openClaudeTab(test.app.runtime, tab)).toBe('8c3efb13-mine');
    expect(bgCall(test)).toStrictEqual(['--bg', '--resume', '8c3efb13-mine']);
    expect(env.host.terminals[0]).toMatchObject({ args: ['attach', '8c3efb13'] });
  });

  it('runs claude in the tab itself and says why when it cannot background the session', async () => {
    const env = await makeEnv();
    const failing = makeApp(env);
    const fresh = { name: 'Claude Code', cwd: env.home, resume: null, env: { OVERLORD_SLOT: '1' } };
    const id = await openClaudeTab(failing.app.runtime, fresh);
    expect(env.host.terminals[0]).toStrictEqual({
      name: 'Claude Code',
      command: 'claude',
      args: ['--session-id', id],
      cwd: env.home,
      sessionId: id,
      env: { OVERLORD_SLOT: '1' },
    });
    expect(failing.app.errorList().at(-1)?.message).toContain('fake failure');

    const silent = makeApp(env, { responders: [background('nothing useful\n')] });
    const resume = { name: 'Claude: Mine', cwd: env.home, resume: 'mine' };
    expect(await openClaudeTab(silent.app.runtime, resume)).toBe('mine');
    expect(env.host.terminals[1]).toStrictEqual({
      name: 'Claude: Mine',
      command: 'claude',
      args: ['--resume', 'mine'],
      cwd: env.home,
      sessionId: 'mine',
    });
    expect(silent.app.errorList().at(-1)?.message).toContain('nothing useful');
  });
});
