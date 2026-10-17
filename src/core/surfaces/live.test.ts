import { describe, expect, it, vi } from 'vitest';

import {
  buildLiveProcessTable,
  mergeLiveProcesses,
  parseAgentsJson,
  readClaudeAgents,
  readSessionRegistry,
} from './live.js';
import type { AgentEntry, LiveProcess, RegistryEntry } from './live.js';
import type { ExecFunction } from './process.js';
import { makeScratchHome } from './test-helpers/scratch-home.js';

const FULL_REGISTRY = {
  pid: 4765,
  sessionId: 'session-a',
  cwd: '/work/a',
  startedAt: 1000,
  procStart: 'ignored',
  version: '2.1.301',
  kind: 'interactive',
  entrypoint: 'cli',
  messagingSocketPath: '/tmp/sock-a',
  name: 'alpha',
  status: 'idle',
  updatedAt: 3000,
  statusUpdatedAt: 2500,
};

function registry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid: 10,
    sessionId: 's1',
    cwd: '/w',
    kind: 'interactive',
    entrypoint: 'cli',
    status: 'idle',
    statusUpdatedAt: 5,
    startedAt: 1,
    updatedAt: 5,
    name: 'reg',
    version: '2.1.301',
    messagingSocketPath: '/sock',
    ...overrides,
  };
}

function agent(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: 'agent-1',
    pid: 20,
    sessionId: 's1',
    cwd: '/agent-cwd',
    kind: 'background',
    name: 'agent-name',
    state: 'working',
    status: 'busy',
    startedAt: 2,
    ...overrides,
  };
}

const aliveSet =
  (...alive: number[]) =>
  (pid: number): boolean =>
    alive.includes(pid);

describe('readSessionRegistry', () => {
  it('returns nothing when the sessions dir is missing', async () => {
    const home = await makeScratchHome();
    await expect(readSessionRegistry(home.paths)).resolves.toStrictEqual({ items: [], errors: [] });
    await home.cleanup();
  });

  it('reads every pid file, sorted by pid, and skips other files', async () => {
    const home = await makeScratchHome();
    await home.writeJson('.claude/sessions/4765.json', FULL_REGISTRY);
    await home.writeJson('.claude/sessions/10.json', { pid: 10, sessionId: 'session-10' });
    // A background session is named after its job id until its first prompt.
    await home.writeJson('.claude/sessions/9.json', {
      pid: 9,
      sessionId: 'session-b',
      kind: 'bg',
      name: '8c3efb13',
      jobId: '8c3efb13',
    });
    await home.writeText('.claude/sessions/4765.abcdef.key', 'secret');
    await home.makeDir('.claude/sessions/99.json');
    const result = await readSessionRegistry(home.paths);
    expect(result.errors).toStrictEqual([]);
    expect(result.items.map((item) => item.pid)).toStrictEqual([9, 10, 4765]);
    expect(result.items.filter((item) => item.pid !== 10)).toStrictEqual([
      {
        pid: 9,
        sessionId: 'session-b',
        cwd: null,
        kind: 'background',
        entrypoint: null,
        status: null,
        statusUpdatedAt: null,
        startedAt: null,
        updatedAt: null,
        name: null,
        version: null,
        messagingSocketPath: null,
      },
      {
        pid: 4765,
        sessionId: 'session-a',
        cwd: '/work/a',
        kind: 'interactive',
        entrypoint: 'cli',
        status: 'idle',
        statusUpdatedAt: 2500,
        startedAt: 1000,
        updatedAt: 3000,
        name: 'alpha',
        version: '2.1.301',
        messagingSocketPath: '/tmp/sock-a',
      },
    ]);
    await home.cleanup();
  });

  it('reports broken files and keeps the good ones', async () => {
    const home = await makeScratchHome();
    await home.writeJson('.claude/sessions/1.json', { pid: 1, sessionId: 'ok' });
    const bad = await home.writeText('.claude/sessions/2.json', '{oops');
    const wrong = await home.writeJson('.claude/sessions/3.json', { pid: 'x', sessionId: '' });
    const result = await readSessionRegistry(home.paths);
    expect(result.items.map((item) => item.sessionId)).toStrictEqual(['ok']);
    expect(result.errors.map((error) => [error.source, error.path])).toStrictEqual(
      expect.arrayContaining([
        ['session-registry', bad],
        ['session-registry', wrong],
      ]),
    );
    expect(result.errors).toHaveLength(2);
    const wrongError = result.errors.find((error) => error.path === wrong);
    expect(wrongError?.message).toMatch(/^unexpected shape: /u);
    await home.cleanup();
  });
});

describe('parseAgentsJson', () => {
  it('parses the documented fields and normalizes nullish ones', () => {
    const stdout = JSON.stringify([
      {
        pid: 91,
        id: 'bg-1',
        cwd: '/c',
        kind: 'background',
        startedAt: 7,
        sessionId: 's-bg',
        name: 'n',
        status: 'busy',
        state: 'working',
      },
      { id: 'bg-2', kind: 'bg', sessionId: 's-stopped', state: 'stopped', pid: null, name: 'bg-2' },
    ]);
    expect(parseAgentsJson(stdout)).toStrictEqual({
      items: [
        {
          id: 'bg-1',
          pid: 91,
          sessionId: 's-bg',
          cwd: '/c',
          kind: 'background',
          name: 'n',
          state: 'working',
          status: 'busy',
          startedAt: 7,
        },
        {
          id: 'bg-2',
          pid: null,
          sessionId: 's-stopped',
          cwd: null,
          kind: 'background',
          name: null,
          state: 'stopped',
          status: null,
          startedAt: null,
        },
      ],
      errors: [],
    });
  });

  it('skips entries without a session id and says which', () => {
    const result = parseAgentsJson(JSON.stringify([{ sessionId: 'a' }, { pid: 3 }, 'x']));
    expect(result.items.map((item) => item.sessionId)).toStrictEqual(['a']);
    expect(result.errors).toStrictEqual([
      { source: 'claude-agents', message: 'entry 1 skipped', path: null },
      { source: 'claude-agents', message: 'entry 2 skipped', path: null },
    ]);
  });

  it('throws when the output is not an array', () => {
    expect(() => parseAgentsJson('{"a":1}')).toThrow(new Error('expected a JSON array'));
    expect(() => parseAgentsJson('not json')).toThrow(SyntaxError);
  });
});

describe('readClaudeAgents', () => {
  it('runs claude agents --json with a 5 second timeout by default', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue({ stdout: '[{"sessionId":"x"}]' });
    const result = await readClaudeAgents(exec);
    expect(exec).toHaveBeenCalledWith('claude', ['agents', '--json'], { timeoutMs: 5000 });
    expect(result.items.map((item) => item.sessionId)).toStrictEqual(['x']);
    expect(result.errors).toStrictEqual([]);
  });

  it('passes --all, a custom binary and timeout', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue({ stdout: '[]' });
    await readClaudeAgents(exec, { includeCompleted: true, claudeBin: '/bin/cc', timeoutMs: 9 });
    expect(exec).toHaveBeenCalledWith('/bin/cc', ['agents', '--json', '--all'], { timeoutMs: 9 });
  });

  it('leaves out --all when includeCompleted is false', async () => {
    const exec = vi.fn<ExecFunction>().mockResolvedValue({ stdout: '[]' });
    await readClaudeAgents(exec, { includeCompleted: false });
    expect(exec).toHaveBeenCalledWith('claude', ['agents', '--json'], { timeoutMs: 5000 });
  });

  it('turns exec failures and bad output into errors', async () => {
    const failing = vi.fn<ExecFunction>().mockRejectedValue(new Error('spawn claude ENOENT'));
    await expect(readClaudeAgents(failing)).resolves.toStrictEqual({
      items: [],
      errors: [{ source: 'claude-agents', message: 'spawn claude ENOENT', path: null }],
    });
    const garbage = vi.fn<ExecFunction>().mockResolvedValue({ stdout: '{}' });
    await expect(readClaudeAgents(garbage)).resolves.toStrictEqual({
      items: [],
      errors: [{ source: 'claude-agents', message: 'expected a JSON array', path: null }],
    });
  });
});

describe('mergeLiveProcesses', () => {
  it('maps a registry entry and checks its pid', () => {
    const isAlive = vi.fn((pid: number) => pid === 10);
    const table = mergeLiveProcesses([registry()], [], isAlive);
    const expected: LiveProcess = {
      sessionId: 's1',
      pid: 10,
      alive: true,
      state: null,
      status: 'idle',
      kind: 'interactive',
      name: 'reg',
      cwd: '/w',
      entrypoint: 'cli',
      version: '2.1.301',
      startedAt: 1,
      updatedAt: 5,
      agentId: null,
      messagingSocketPath: '/sock',
      sources: ['registry'],
    };
    expect([...table.entries()]).toStrictEqual([['s1', expected]]);
    expect(isAlive).toHaveBeenCalledWith(10);
  });

  it('marks a stale registry entry dead', () => {
    const table = mergeLiveProcesses([registry()], [], aliveSet());
    expect(table.get('s1')?.alive).toBe(false);
  });

  it('prefers the live file when two files name one session, in either order', () => {
    const dead = registry({ pid: 1, updatedAt: 999 });
    const live = registry({ pid: 2, updatedAt: 1 });
    expect(mergeLiveProcesses([dead, live], [], aliveSet(2)).get('s1')?.pid).toBe(2);
    expect(mergeLiveProcesses([live, dead], [], aliveSet(2)).get('s1')?.pid).toBe(2);
  });

  it('prefers the newer file when both are alive or both dead', () => {
    const old = registry({ pid: 1, updatedAt: 1 });
    const fresh = registry({ pid: 2, updatedAt: 2 });
    expect(mergeLiveProcesses([old, fresh], [], aliveSet()).get('s1')?.pid).toBe(2);
    expect(mergeLiveProcesses([fresh, old], [], aliveSet()).get('s1')?.pid).toBe(2);
    expect(mergeLiveProcesses([old, fresh], [], aliveSet(1, 2)).get('s1')?.pid).toBe(2);
    expect(mergeLiveProcesses([fresh, old], [], aliveSet(1, 2)).get('s1')?.pid).toBe(2);
  });

  it('treats a missing updatedAt as oldest and keeps the first on a tie', () => {
    const none = registry({ pid: 1, updatedAt: null });
    const some = registry({ pid: 2, updatedAt: 1 });
    expect(mergeLiveProcesses([some, none], [], aliveSet()).get('s1')?.pid).toBe(2);
    expect(mergeLiveProcesses([none, some], [], aliveSet()).get('s1')?.pid).toBe(2);
    const twin = registry({ pid: 3, updatedAt: 1 });
    expect(mergeLiveProcesses([some, twin], [], aliveSet()).get('s1')?.pid).toBe(2);
    const noneToo = registry({ pid: 4, updatedAt: null });
    expect(mergeLiveProcesses([none, noneToo], [], aliveSet()).get('s1')?.pid).toBe(1);
  });

  it('keeps sessions with different ids apart', () => {
    const table = mergeLiveProcesses(
      [registry({ sessionId: 'a' }), registry({ sessionId: 'b', pid: 11 })],
      [],
      aliveSet(10),
    );
    expect([...table.keys()]).toStrictEqual(['a', 'b']);
    expect(table.get('a')?.alive).toBe(true);
    expect(table.get('b')?.alive).toBe(false);
  });

  it('adds a session only claude agents knows about', () => {
    const table = mergeLiveProcesses([], [agent()], aliveSet(20));
    const expected: LiveProcess = {
      sessionId: 's1',
      pid: 20,
      alive: true,
      state: 'working',
      status: 'busy',
      kind: 'background',
      name: 'agent-name',
      cwd: '/agent-cwd',
      entrypoint: null,
      version: null,
      startedAt: 2,
      updatedAt: null,
      agentId: 'agent-1',
      messagingSocketPath: null,
      sources: ['agents'],
    };
    expect(table.get('s1')).toStrictEqual(expected);
  });

  it('lets claude agents override the registry and keeps registry-only fields', () => {
    const table = mergeLiveProcesses([registry()], [agent()], aliveSet(20));
    expect(table.get('s1')).toStrictEqual({
      sessionId: 's1',
      pid: 20,
      alive: true,
      state: 'working',
      status: 'busy',
      kind: 'background',
      name: 'agent-name',
      cwd: '/agent-cwd',
      entrypoint: 'cli',
      version: '2.1.301',
      startedAt: 2,
      updatedAt: 5,
      agentId: 'agent-1',
      messagingSocketPath: '/sock',
      sources: ['registry', 'agents'],
    });
  });

  it('falls back to registry values when claude agents leaves them out', () => {
    const sparse = agent({
      id: null,
      pid: null,
      cwd: null,
      kind: null,
      name: null,
      state: null,
      status: null,
      startedAt: null,
    });
    const table = mergeLiveProcesses([registry()], [sparse], aliveSet(10));
    expect(table.get('s1')).toMatchObject({
      pid: 10,
      alive: true,
      state: null,
      status: 'idle',
      kind: 'interactive',
      name: 'reg',
      cwd: '/w',
      startedAt: 1,
      agentId: null,
    });
  });

  it('marks a stopped agent with no pid dead without asking about a pid', () => {
    const isAlive = vi.fn(() => true);
    const table = mergeLiveProcesses([], [agent({ pid: null, state: 'stopped' })], isAlive);
    expect(table.get('s1')?.alive).toBe(false);
    expect(table.get('s1')?.pid).toBeNull();
    expect(isAlive).not.toHaveBeenCalled();
  });
});

describe('buildLiveProcessTable', () => {
  it('merges both sources and passes options through', async () => {
    const home = await makeScratchHome();
    await home.writeJson('.claude/sessions/10.json', { pid: 10, sessionId: 'reg-only' });
    await home.writeText('.claude/sessions/11.json', 'bad');
    const exec = vi.fn<ExecFunction>().mockResolvedValue({
      stdout: JSON.stringify([{ sessionId: 'agent-only', pid: 20 }]),
    });
    const table = await buildLiveProcessTable({
      paths: home.paths,
      exec,
      isAlive: aliveSet(10),
      options: { includeCompleted: true },
    });
    expect([...table.processes.keys()]).toStrictEqual(['reg-only', 'agent-only']);
    expect(table.processes.get('reg-only')?.alive).toBe(true);
    expect(table.processes.get('agent-only')?.alive).toBe(false);
    expect(table.errors.map((error) => error.source)).toStrictEqual(['session-registry']);
    expect(exec).toHaveBeenCalledWith('claude', ['agents', '--json', '--all'], {
      timeoutMs: 5000,
    });
    await home.cleanup();
  });

  it('still returns claude agents rows when the registry cannot be listed', async () => {
    const home = await makeScratchHome();
    await home.writeText('.claude/sessions', 'not a dir');
    const exec = vi.fn<ExecFunction>().mockResolvedValue({ stdout: '[{"sessionId":"a"}]' });
    const table = await buildLiveProcessTable({ paths: home.paths, exec, isAlive: aliveSet() });
    expect([...table.processes.keys()]).toStrictEqual(['a']);
    expect(table.errors).toHaveLength(1);
    expect(table.errors[0]?.source).toBe('session-registry');
    expect(table.errors[0]?.path).toBe(home.paths.sessionsDir);
    expect(table.errors[0]?.message).toMatch(/ENOTDIR/u);
    expect(exec).toHaveBeenCalledWith('claude', ['agents', '--json'], { timeoutMs: 5000 });
    await home.cleanup();
  });

  it('still returns registry rows when claude agents fails', async () => {
    const home = await makeScratchHome();
    await home.writeJson('.claude/sessions/10.json', { pid: 10, sessionId: 'r' });
    const exec = vi.fn<ExecFunction>().mockRejectedValue(new Error('timeout'));
    const table = await buildLiveProcessTable({ paths: home.paths, exec, isAlive: aliveSet() });
    expect([...table.processes.keys()]).toStrictEqual(['r']);
    expect(table.errors).toStrictEqual([
      { source: 'claude-agents', message: 'timeout', path: null },
    ]);
    await home.cleanup();
  });
});
