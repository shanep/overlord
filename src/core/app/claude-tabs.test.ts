import { describe, expect, it } from 'vitest';

import type { ExecResult } from '../sync/exec.js';

import { openClaudeTab } from './claude-tabs.js';
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
    const test = makeApp(env, { responders: [background(BACKGROUNDED), agents([])] });
    const tab = { name: 'Claude Code', cwd: env.home, resume: null, env: { OVERLORD_SLOT: '3' } };
    // Claude Code does not list the session yet, so the tab opens without its id.
    expect(await openClaudeTab(test.app.runtime, tab)).toBeNull();
    expect(bgCall(test)).toStrictEqual(['--bg', '--settings', '{"env":{"OVERLORD_SLOT":"3"}}']);
    expect(test.calls.filter((call) => call.args[0] === 'agents')).toHaveLength(3);
    expect(env.host.terminals[0]).toMatchObject({ args: ['attach', '8c3efb13'], sessionId: null });
  });

  it('continues a session in the background under its own id', async () => {
    const env = await makeEnv();
    const test = makeApp(env, { responders: [background(BACKGROUNDED)] });
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
