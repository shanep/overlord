import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { SurfaceSession } from '../../../shared/protocol.js';
import { AGENT_TITLE, HERE_ID } from '../../app/actions-open-project.js';
import { openClaudeTab } from '../../app/claude-tabs.js';
import type { TestApp } from '../../app/test-helpers/fixtures.js';
import { makeApp, makeEnv, ok } from '../../app/test-helpers/fixtures.js';
import { buildConnectors } from '../../app/views/connectors.js';
import type { ClaudePaths } from '../../paths.js';
import type { ExecResult } from '../../sync/exec.js';
import type { LiveSources } from '../types.js';

import { copilotTerminal, findCopilot } from './terminal.js';

const ID = '11111111-1111-4111-8111-000000000001';
const FIXTURE = fileURLToPath(
  new URL(
    `../../../../test/fixtures/copilot/1.0.89/session-state/${ID}/events.jsonl`,
    import.meta.url,
  ),
);

const PS = [
  '  100     1 /bin/zsh -l',
  `  200   100 /opt/homebrew/bin/copilot --session-id ${ID}`,
  `  300   100 node /usr/local/bin/copilot --resume=11111111-1111-4111-8111-000000000002`,
  `  301   300 /usr/local/lib/node_modules/@github/copilot/copilot --resume=11111111-1111-4111-8111-000000000002`,
  '  400   100 copilot -r 11111111-1111-4111-8111-000000000003 --model gpt-5-mini',
  '  500   100 copilot',
  `  600   100 grep -- --session-id ${ID}`,
].join('\n');

const ROW: SurfaceSession = {
  id: ID,
  agent: 'copilot',
  surface: 'cli',
  title: 'Reply with the word ok',
  cwd: '/work/repo',
  updatedAt: 0,
  archived: false,
  handoffs: ['resume-local'],
};

function sources(
  paths: ClaudePaths,
  stdout: string,
  alive = true,
): LiveSources & { readonly bin: string } {
  return {
    paths,
    exec: async (): Promise<{ stdout: string }> => {
      await Promise.resolve();
      return { stdout };
    },
    isAlive: () => alive,
    bin: 'copilot',
  };
}

describe('copilotTerminal', () => {
  it('picks a new session id up front and passes a first prompt that starts with a dash', () => {
    expect(copilotTerminal.command).toBe('copilot');
    expect(copilotTerminal.presetId).toBe(true);
    expect(copilotTerminal.newArgs({ sessionId: ID, prompt: null })).toStrictEqual([
      '--session-id',
      ID,
    ]);
    expect(copilotTerminal.newArgs({ sessionId: ID, prompt: '- fix the bug' })).toStrictEqual([
      '--session-id',
      ID,
      '--interactive=- fix the bug',
    ]);
  });

  it('starts a tab on the profile model, effort and mode with the flags Launcher runs get', () => {
    expect(
      copilotTerminal.launchArgs?.({ model: 'gpt-5-mini', effort: 'high', permissionMode: 'plan' }),
    ).toStrictEqual(['--model=gpt-5-mini', '--reasoning-effort=high', '--mode=plan']);
    expect(
      copilotTerminal.launchArgs?.({ model: null, effort: null, permissionMode: 'allow-all' }),
    ).toStrictEqual(['--allow-all']);
    expect(
      copilotTerminal.launchArgs?.({ model: null, effort: null, permissionMode: null }),
    ).toStrictEqual([]);
  });

  it('resumes by id and refuses a fork with a message that says what to do', () => {
    const start = { sessionId: 'unused', prompt: null };
    expect(copilotTerminal.resumeArgs(ID, false, start)).toStrictEqual([`--resume=${ID}`]);
    expect(copilotTerminal.resumeArgs(ID, false, { ...start, prompt: 'Go on' })).toStrictEqual([
      `--resume=${ID}`,
      '--interactive=Go on',
    ]);
    expect(() => copilotTerminal.resumeArgs(ID, true, start)).toThrow(/Use \/fork in its tab/u);
  });

  it('names its tabs, leaves interrupts to the tab and offers only resume as a handoff', () => {
    expect(copilotTerminal.tabName('11111111')).toBe('Copilot 11111111');
    expect(copilotTerminal.interruptSignal).toBeNull();
    expect(copilotTerminal.background).toBeUndefined();
    expect(copilotTerminal.handoff?.('resume-local', ROW, '/bin/copilot')).toMatchObject({
      command: '/bin/copilot',
      args: [`--resume=${ID}`],
    });
    expect(copilotTerminal.handoff?.('open-desktop', ROW, '/bin/copilot')).toBeNull();
  });

  it('finds the outermost copilot process that names a session, by any of its flags', async () => {
    expect(findCopilot(PS, ID)).toBe(200);
    expect(findCopilot(PS, '11111111-1111-4111-8111-000000000002')).toBe(300);
    expect(findCopilot(PS, '11111111-1111-4111-8111-000000000003')).toBe(400);
    expect(findCopilot(PS, '11111111-1111-4111-8111-000000000009')).toBeNull();
    const { paths } = await makeEnv();
    expect(await copilotTerminal.findLive(sources(paths, PS), ID)).toMatchObject({
      sessionId: ID,
      pid: 200,
      alive: true,
      kind: 'interactive',
    });
    expect(await copilotTerminal.findLive(sources(paths, PS, false), ID)).toBeUndefined();
    const failing = {
      ...sources(paths, PS),
      exec: async (): Promise<never> => {
        await Promise.resolve();
        throw new Error('no ps');
      },
    };
    expect(await copilotTerminal.findLive(failing, ID)).toBeUndefined();
  });
});

/** An app whose login shell finds a fake copilot, with Copilot's files in their own home. */
async function copilotApp(): Promise<{ readonly test: TestApp; readonly copilotHome: string }> {
  const env = await makeEnv();
  const bin = path.join(env.root, 'bin');
  const copilotHome = path.join(env.root, 'copilot-home');
  await mkdir(bin, { recursive: true });
  await mkdir(copilotHome, { recursive: true });
  // It only has to be there for detect, which never runs it.
  await writeFile(path.join(bin, 'copilot'), '#!/bin/sh\nexit 1\n');
  await chmod(path.join(bin, 'copilot'), 0o755);
  const test = makeApp(env, {
    responders: [(call): ExecResult | undefined => (call.args[0] === 'mcp' ? ok('') : undefined)],
    deps: { env: { PATH: bin, COPILOT_HOME: copilotHome } },
  });
  return { test, copilotHome };
}

/** A session Copilot left on disk, run in cwd. */
async function writeSession(copilotHome: string, cwd: string): Promise<void> {
  const dir = path.join(copilotHome, 'session-state', ID);
  await mkdir(dir, { recursive: true });
  await copyFile(FIXTURE, path.join(dir, 'events.jsonl'));
  await writeFile(
    path.join(dir, 'workspace.yaml'),
    `id: ${ID}\ncwd: ${cwd}\nname: Reply with the word ok\n`,
  );
}

describe('a Copilot tab', () => {
  it('ties a new tab to its preset id, which the session Copilot writes then takes', async () => {
    const { test, copilotHome } = await copilotApp();
    const rt = test.app.runtime;
    const work = path.join(test.env.root, 'work');
    await mkdir(work, { recursive: true });
    const opened = await openClaudeTab(rt, {
      agent: 'copilot',
      name: 'Copilot CLI',
      cwd: work,
      resume: null,
      newId: ID,
      prompt: 'Reply with the word ok',
    });
    expect(opened).toBe(ID);
    expect(test.env.host.terminals.at(-1)).toMatchObject({
      command: 'copilot',
      args: ['--session-id', ID, '--interactive=Reply with the word ok'],
      sessionId: ID,
    });
    await writeSession(copilotHome, work);
    await rt.caches.sessions.refresh();
    const row = rt.caches.sessions.peek().sessions.find((item) => item.id === ID);
    expect(row).toMatchObject({ agent: 'copilot', cwd: work, handoffs: ['resume-local'] });
  });

  it('continues a session from its row in a tab running copilot --resume', async () => {
    const { test, copilotHome } = await copilotApp();
    const work = path.join(test.env.root, 'work');
    await mkdir(work, { recursive: true });
    await writeSession(copilotHome, work);
    await test.app.dispatch({ type: 'handoff', sessionId: ID, kind: 'resume-local' }, {});
    expect(test.env.host.terminals.at(-1)).toMatchObject({
      command: 'copilot',
      args: [`--resume=${ID}`],
      cwd: work,
      sessionId: ID,
    });
  });

  it('starts from the Fleet menu, and the sparkle asks which agent once Copilot is installed', async () => {
    const { test } = await copilotApp();
    const rt = test.app.runtime;
    const work = path.join(test.env.root, 'work');
    await mkdir(work, { recursive: true });
    test.env.host.workspace = work;
    await rt.caches.agents.refresh();
    test.env.host.pickAnswers.push(HERE_ID);
    await test.app.dispatch({ type: 'newSession', agent: 'copilot' }, {});
    expect(test.env.host.picks.map((pick) => pick.placeholder)).not.toContain(AGENT_TITLE);
    const fromMenu = test.env.host.terminals.at(-1);
    expect(fromMenu).toMatchObject({ command: 'copilot', name: 'Copilot CLI' });
    expect(fromMenu?.args.slice(0, 1)).toStrictEqual(['--session-id']);
    expect(fromMenu?.sessionId).toBe(fromMenu?.args[1]);
    test.env.host.pickAnswers.push('copilot', HERE_ID);
    await test.app.dispatch({ type: 'newSession' }, {});
    expect(test.env.host.picks.at(-2)).toMatchObject({
      placeholder: AGENT_TITLE,
      items: [{ id: 'claude-code' }, { id: 'copilot' }],
    });
    expect(test.env.host.terminals).toHaveLength(2);
    expect(test.env.host.terminals.at(-1)).toMatchObject({ command: 'copilot' });
    expect(test.env.host.progress.at(-1)).toBe('Starting Copilot CLI');
  });

  it('lists Copilot MCP servers on the Connectors view from its own home', async () => {
    const { test, copilotHome } = await copilotApp();
    await writeFile(
      path.join(copilotHome, 'mcp-config.json'),
      JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['-y', 'docs-mcp'] } } }),
    );
    const rt = test.app.runtime;
    await rt.caches.connectors.refresh();
    const state = buildConnectors(rt);
    expect(state.mcpAgents).toContain('copilot');
    expect(state.connectors.filter((item) => item.agent === 'copilot')).toMatchObject([
      { name: 'docs', kind: 'mcp' },
    ]);
  });
});
