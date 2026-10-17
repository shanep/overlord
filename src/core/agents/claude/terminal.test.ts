import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SurfaceSession } from '../../../shared/protocol.js';
import { resolveClaudePaths } from '../../paths.js';
import type { ClaudePaths } from '../../paths.js';
import type { ExecFunction } from '../../surfaces/process.js';
import type { Exec, ExecResult } from '../../sync/exec.js';

import { claudeTerminal } from './terminal.js';

const CLI = { bin: '/bin/claude', env: { HOME: '/home/me' } };

interface Ran {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: object;
}

function runner(result: ExecResult): { readonly run: Exec; readonly calls: Ran[] } {
  const calls: Ran[] = [];
  const run: Exec = async (command, args, options) => {
    calls.push({ command, args, options });
    await Promise.resolve();
    return result;
  };
  return { run, calls };
}

const SESSION: SurfaceSession = {
  id: 'abc',
  agent: 'claude-code',
  surface: 'cli',
  title: 'Fix',
  cwd: '/work',
  updatedAt: 0,
  archived: false,
  handoffs: [],
};

describe('claudeTerminal', () => {
  it('starts, resumes and forks a session in a tab, with or without a first prompt', () => {
    const start = { sessionId: 'new', prompt: null };
    expect(claudeTerminal.newArgs(start)).toStrictEqual(['--session-id', 'new']);
    expect(claudeTerminal.newArgs({ ...start, prompt: 'go' })).toStrictEqual([
      '--session-id',
      'new',
      'go',
    ]);
    expect(
      claudeTerminal.resumeArgs('old', false, { sessionId: 'old', prompt: null }),
    ).toStrictEqual(['--resume', 'old']);
    expect(claudeTerminal.resumeArgs('old', true, { ...start, prompt: 'go' })).toStrictEqual([
      '--resume',
      'old',
      '--fork-session',
      '--session-id',
      'new',
      'go',
    ]);
    expect([claudeTerminal.command, claudeTerminal.presetId]).toStrictEqual(['claude', true]);
    expect(claudeTerminal.interruptSignal).toBe('SIGINT');
    expect(claudeTerminal.tabName('8c3efb13')).toBe('Claude 8c3efb13');
  });

  it('starts a background job and reads its short id, or says why it did not start', async () => {
    const background = claudeTerminal.background;
    const input = { cli: CLI, cwd: '/work', resume: null, fork: false, env: {}, prompt: null };
    const started = runner({ code: 0, stdout: 'backgrounded · 8c3efb13 (idle)\n', stderr: '' });
    await expect(background?.start({ ...input, run: started.run })).resolves.toStrictEqual({
      jobId: '8c3efb13',
    });
    expect(started.calls).toStrictEqual([
      {
        command: '/bin/claude',
        args: ['--bg'],
        options: { cwd: '/work', timeoutMs: 30_000, env: CLI.env },
      },
    ]);
    const failed = runner({ code: 2, stdout: '', stderr: 'not logged in\nmore' });
    await expect(background?.start({ ...input, run: failed.run })).resolves.toStrictEqual({
      error: 'claude --bg did not start a session (exit 2): not logged in',
    });
  });

  it('attaches to, lists and stops background jobs', async () => {
    const background = claudeTerminal.background;
    expect(background?.attachArgs('8c3efb13')).toStrictEqual(['attach', '8c3efb13']);
    const listed: (readonly string[])[] = [];
    const exec: ExecFunction = async (command, args) => {
      listed.push([command, ...args]);
      await Promise.resolve();
      return { stdout: JSON.stringify([{ id: '8c3efb13', sessionId: 's', kind: 'bg' }]) };
    };
    const all = await background?.list({ exec, bin: '/bin/claude', all: true });
    expect(all?.items.map((item) => [item.id, item.kind])).toStrictEqual([
      ['8c3efb13', 'background'],
    ]);
    await background?.list({ exec, bin: '/bin/claude', all: false });
    expect(listed).toStrictEqual([
      ['/bin/claude', 'agents', '--json', '--all'],
      ['/bin/claude', 'agents', '--json'],
    ]);
    const stopped = runner({ code: 0, stdout: '', stderr: '' });
    await expect(background?.stop({ run: stopped.run, cli: CLI, jobId: 'j' })).resolves.toBeNull();
    expect(stopped.calls).toStrictEqual([
      { command: '/bin/claude', args: ['stop', 'j'], options: { timeoutMs: 15_000, env: CLI.env } },
    ]);
    const refused = runner({ code: 1, stdout: '', stderr: ' no such job \n' });
    await expect(background?.stop({ run: refused.run, cli: CLI, jobId: 'j' })).resolves.toBe(
      'claude stop j failed: no such job',
    );
    expect(background?.attachClients(' 41 40 /usr/bin/claude attach 8c3efb13\n')).toStrictEqual([
      { pid: 41, target: '8c3efb13' },
    ]);
  });

  it('builds the handoffs Claude Code offers for a session', () => {
    expect(claudeTerminal.handoff?.('resume-local', SESSION, '/bin/claude')).toMatchObject({
      command: '/bin/claude',
      args: ['--resume', 'abc'],
    });
    expect(claudeTerminal.handoff?.('teleport-local', SESSION, '/bin/claude')).toBeNull();
  });
});

const noAgents: ExecFunction = async () => {
  await Promise.resolve();
  return { stdout: '[]' };
};

describe('claudeTerminal records', () => {
  let home: string;
  let paths: ClaudePaths;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'overlord-claude-terminal-'));
    paths = resolveClaudePaths({ home, platform: 'linux', env: {} });
    await mkdir(paths.sessionsDir, { recursive: true });
    await writeFile(
      path.join(paths.sessionsDir, '7.json'),
      JSON.stringify({ pid: 7, sessionId: 'live', kind: 'interactive', cwd: '/work' }),
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('reads the session registry and finds a live session in it', async () => {
    const sources = { paths, exec: noAgents, isAlive: (pid: number): boolean => pid === 7 };
    const registry = await claudeTerminal.registry?.(sources);
    expect(registry?.items.map((entry) => entry.sessionId)).toStrictEqual(['live']);
    const live = await claudeTerminal.findLive({ ...sources, bin: 'claude' }, 'live');
    expect([live?.pid, live?.alive, live?.cwd]).toStrictEqual([7, true, '/work']);
    await expect(claudeTerminal.findLive({ ...sources, bin: 'claude' }, 'gone')).resolves.toBe(
      undefined,
    );
  });
});
