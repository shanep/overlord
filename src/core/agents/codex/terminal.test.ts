import { describe, expect, it } from 'vitest';

import type { SurfaceSession } from '../../../shared/protocol.js';
import { newSessionIn } from '../../app/agent-terminal.js';
import { openClaudeTab } from '../../app/claude-tabs.js';
import { makeApp, makeEnv, ok, session } from '../../app/test-helpers/fixtures.js';
import type { ClaudePaths } from '../../paths.js';
import type { ExecResult } from '../../sync/exec.js';
import type { LiveSources } from '../types.js';

import { codexTerminal, findResumed } from './terminal.js';

const ID = '01a1480a-d128-7ff0-b026-896f6f880226';

const PS = [
  '  100     1 /bin/zsh -l',
  `  200   100 node /usr/local/bin/codex resume ${ID}`,
  `  201   200 /usr/local/lib/node_modules/@openai/codex/vendor/bin/codex resume ${ID}`,
  '  300   100 codex resume 01a1480a-0000-7000-8000-000000000000',
  '  400   100 codex',
  `  500   100 vim notes-about-codex-resume-${ID}.txt`,
].join('\n');

const ROW: SurfaceSession = {
  id: ID,
  agent: 'codex',
  surface: 'cli',
  title: 'Edit notes',
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
    bin: 'codex',
  };
}

describe('codexTerminal', () => {
  it('starts codex with the prompt and resumes or forks by id', () => {
    expect(codexTerminal.presetId).toBe(false);
    expect(codexTerminal.newArgs({ sessionId: 'x', prompt: null })).toStrictEqual([]);
    expect(codexTerminal.newArgs({ sessionId: 'x', prompt: 'Fix it' })).toStrictEqual(['Fix it']);
    expect(codexTerminal.resumeArgs(ID, false, { sessionId: 'x', prompt: null })).toStrictEqual([
      'resume',
      ID,
    ]);
    expect(codexTerminal.resumeArgs(ID, true, { sessionId: 'x', prompt: 'Go on' })).toStrictEqual([
      'fork',
      ID,
      'Go on',
    ]);
    expect(codexTerminal.tabName('8c3efb13')).toBe('Codex 8c3efb13');
    expect(codexTerminal.interruptSignal).toBeNull();
  });

  it('offers only resume as a handoff', () => {
    expect(codexTerminal.handoff?.('resume-local', ROW, '/bin/codex')).toMatchObject({
      command: '/bin/codex',
      args: ['resume', ID],
    });
    expect(codexTerminal.handoff?.('open-desktop', ROW, '/bin/codex')).toBeNull();
  });

  it('finds the outermost process resuming a session and nothing for a new one', async () => {
    const { paths } = await makeEnv();
    expect(findResumed(PS, ID)).toBe(200);
    expect(findResumed(PS, '01a1480a-ffff-7000-8000-000000000000')).toBeNull();
    expect(await codexTerminal.findLive(sources(paths, PS), ID)).toMatchObject({
      sessionId: ID,
      pid: 200,
      alive: true,
      kind: 'interactive',
    });
    expect(await codexTerminal.findLive(sources(paths, PS, false), ID)).toBeUndefined();
    const failing = {
      ...sources(paths, PS),
      exec: async (): Promise<never> => {
        await Promise.resolve();
        throw new Error('no ps');
      },
    };
    expect(await codexTerminal.findLive(failing, ID)).toBeUndefined();
  });
});

describe('a Codex tab', () => {
  it('opens untied and links to the session Codex starts in its folder', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env, { responders: [(): ExecResult => ok('')] });
    const rt = app.runtime;
    const opened = await openClaudeTab(rt, {
      agent: 'codex',
      name: 'Codex new',
      cwd: '/work/repo',
      resume: null,
      prompt: 'Hello',
    });
    expect(opened).toBeNull();
    const request = env.host.terminals.at(-1);
    expect(request).toMatchObject({ command: 'codex', args: ['Hello'], sessionId: null });
    const now = rt.clock();
    rt.bus.emit(
      'session.upserted',
      session('elsewhere', { agent: 'codex', cwd: '/other', startedAt: now }),
    );
    rt.bus.emit('session.upserted', session('claude-one', { cwd: '/work/repo', startedAt: now }));
    rt.bus.emit(
      'session.upserted',
      session(ID, { agent: 'codex', cwd: '/work/repo', startedAt: now }),
    );
    expect(await request?.sessionLater).toBe(ID);
  });

  it('ties a resumed tab at once and gives up on a session that never shows', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await openClaudeTab(app.runtime, { agent: 'codex', name: 'Codex', cwd: '/w', resume: ID });
    expect(env.host.terminals.at(-1)).toMatchObject({ args: ['resume', ID], sessionId: ID });
    expect(env.host.terminals.at(-1)?.sessionLater).toBeUndefined();
    expect(await newSessionIn(app.runtime, 'codex', '/w', 1)).toBeNull();
  });
});
