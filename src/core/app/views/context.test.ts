import path from 'node:path';

import { describe, expect, it, vi, type Mock } from 'vitest';

import type { ContextSnapshot, LoadedInstruction } from '../../../shared/model.js';
import { EventBus } from '../../bus.js';
import type { FileSystem } from '../../context/fs.js';
import { createNodeFileSystem } from '../../context/fs.js';
import { OverlordStore } from '../../store/store.js';
import {
  agent,
  makeEnv,
  NOW,
  recordingExec,
  session,
  settle,
  sorted,
  toolCall,
  waitFor,
  writeJson,
  writeText,
  immediateScheduler,
} from '../test-helpers/fixtures.js';

import { mergeLoaded, pathInput, resolveSnapshot, touchedFiles } from './context-resolve.js';
import { ContextViews } from './context.js';

function loaded(file: string, overrides: Partial<LoadedInstruction> = {}): LoadedInstruction {
  return {
    path: file,
    tier: 'Project',
    reason: 'session_start',
    triggerPath: null,
    parentPath: null,
    globs: [],
    bytes: 10,
    differsFromDisk: null,
    loadedAt: null,
    ...overrides,
  };
}

function snapshot(sessionId: string, overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    sessionId,
    agentId: sessionId,
    at: NOW,
    systemPrompt: ['You are Claude Code.'],
    model: 'claude-opus-5-5',
    loaded: [],
    skipped: [],
    skills: [],
    agentTypes: [],
    mcpServers: [],
    deferredTools: [],
    environment: {},
    weights: [],
    ...overrides,
  };
}

async function setup(fs: FileSystem = createNodeFileSystem()): Promise<{
  views: ContextViews;
  bus: EventBus;
  store: OverlordStore;
  workspace: string;
  calls: ReturnType<typeof recordingExec>['calls'];
  onUpdate: Mock<() => void>;
  onError: Mock<(source: string, message: string) => void>;
  paths: Awaited<ReturnType<typeof makeEnv>>['paths'];
}> {
  const env = await makeEnv({ workspace: true });
  const workspace = env.host.workspace ?? '';
  await writeText(path.join(workspace, 'CLAUDE.md'), '# project rules\n');
  await writeText(
    path.join(env.paths.userSkillsDir, 'tidy', 'SKILL.md'),
    '---\nname: tidy\ndescription: Tidy up.\n---\nDo it.\n',
  );
  const bus = new EventBus();
  const store = new OverlordStore(bus, { scheduler: immediateScheduler });
  const { exec, calls } = recordingExec();
  const onUpdate = vi.fn<() => void>();
  const onError = vi.fn<(source: string, message: string) => void>();
  const views = new ContextViews({
    paths: env.paths,
    fs,
    exec,
    env: {},
    store,
    clock: (): number => NOW,
    onUpdate,
    onError,
  });
  return { views, bus, store, workspace, calls, onUpdate, onError, paths: env.paths };
}

function revParses(calls: readonly { readonly args: readonly string[] }[]): number {
  return calls.filter((call) => call.args.includes('rev-parse')).length;
}

describe('pathInput', () => {
  it('finds file_path, then path, in a tool input', () => {
    expect(pathInput({ file_path: '/a', path: '/b' })).toBe('/a');
    expect(pathInput({ path: '/b' })).toBe('/b');
    expect(pathInput({ file_path: '', path: '/b' })).toBe('/b');
    expect(pathInput({ file_path: 3 })).toBeNull();
    expect(pathInput({ command: 'ls' })).toBeNull();
    expect(pathInput('text')).toBeNull();
    expect(pathInput(null)).toBeNull();
  });
});

describe('mergeLoaded', () => {
  it('keeps the first list and adds new paths from the second', () => {
    const first = [loaded('/a'), loaded('/b')];
    const merged = mergeLoaded(first, [loaded('/b', { bytes: 99 }), loaded('/c')]);
    expect(merged.map((item) => [item.path, item.bytes])).toStrictEqual([
      ['/a', 10],
      ['/b', 10],
      ['/c', 10],
    ]);
  });
});

describe('touchedFiles', () => {
  it('collects file tool paths from every agent of the session, resolved against cwd', async () => {
    const { bus, store } = await setup();
    bus.emit('agent.upserted', agent('s1', 's1'));
    bus.emit('agent.upserted', agent('s1', 'sub'));
    bus.emit('agent.upserted', agent('other', 'x'));
    bus.emit('tool.upserted', toolCall('s1', 's1', 't1', { file_path: 'src/a.ts' }));
    bus.emit('tool.upserted', toolCall('s1', 'sub', 't2', { path: '/abs/b.ts' }));
    bus.emit('tool.upserted', toolCall('s1', 'sub', 't3', { file_path: 'src/a.ts' }));
    bus.emit('tool.upserted', toolCall('s1', 's1', 't4', { command: 'ls' }));
    bus.emit('tool.upserted', toolCall('other', 'x', 't5', { file_path: '/nope' }));
    expect(sorted(touchedFiles(store, { id: 's1', cwd: '/w' }, NOW))).toStrictEqual([
      '/abs/b.ts',
      path.resolve('/w', 'src/a.ts'),
    ]);
  });

  it('reads the main thread even when no agent node exists for it', async () => {
    const { bus, store } = await setup();
    bus.emit('tool.upserted', toolCall('s1', 's1', 't1', { file_path: '/x' }));
    expect(touchedFiles(store, { id: 's1', cwd: '/w' }, NOW)).toStrictEqual(['/x']);
  });
});

describe('resolveSnapshot', () => {
  it('fills loaded, skills and estimated weights from the disk', async () => {
    const { store, workspace, calls, paths } = await setup();
    await writeJson(path.join(workspace, '.mcp.json'), {
      mcpServers: { pending: { command: 'x' } },
    });
    const summary = session('s1', { cwd: workspace });
    const merged = await resolveSnapshot(
      {
        paths,
        fs: createNodeFileSystem(),
        exec: recordingExec().exec,
        env: {},
        store,
        clock: () => NOW,
      },
      { base: snapshot('s1'), session: summary, agentId: 's1', observed: [] },
    );
    expect(merged.loaded.map((item) => item.path)).toContain(path.join(workspace, 'CLAUDE.md'));
    expect(merged.skills.map((skill) => skill.name)).toContain('tidy');
    expect(merged.weights.map((weight) => weight.label)).toContain('System prompt');
    expect(merged.systemPrompt).toStrictEqual(['You are Claude Code.']);
    // Claude's transcript lists the servers it loaded, so the files add none.
    expect(merged.mcpServers).toStrictEqual([]);
    expect(calls).toStrictEqual([]);
  });

  it("lists a Copilot session's skills from its skills folder and not Claude's own", async () => {
    const { store, workspace, paths } = await setup();
    await writeText(
      path.join(workspace, '.github', 'skills', 'ship', 'SKILL.md'),
      '---\nname: ship\ndescription: Ship it.\n---\nDo it.\n',
    );
    const merged = await resolveSnapshot(
      {
        paths,
        fs: createNodeFileSystem(),
        exec: recordingExec().exec,
        env: {},
        store,
        clock: () => NOW,
      },
      {
        base: snapshot('c1'),
        session: session('c1', { cwd: workspace, agent: 'copilot' }),
        agentId: 'c1',
        observed: [],
      },
    );
    const names = merged.skills.map((skill) => skill.name);
    expect(names).toContain('ship');
    // ~/.claude/skills is Claude Code's alone.
    expect(names).not.toContain('tidy');
  });

  it("shows a Copilot session's instruction files and the MCP servers its store turns on", async () => {
    const { store, workspace, paths } = await setup();
    const instructions = path.join(workspace, '.github', 'copilot-instructions.md');
    await writeText(instructions, '# rules\n');
    await writeJson(path.join(workspace, '.github', 'mcp.json'), {
      mcpServers: { docs: { command: 'docs-mcp' }, quiet: { command: 'quiet-mcp' } },
    });
    const copilotHome = path.join(paths.home, '.copilot');
    await writeJson(path.join(copilotHome, 'mcp-config.json'), {
      mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
    });
    await writeText(
      path.join(copilotHome, 'settings.json'),
      '// User settings belong in settings.json.\n{ "disabledMcpServers": ["quiet"] }\n',
    );
    const deps = {
      paths,
      fs: createNodeFileSystem(),
      exec: recordingExec().exec,
      env: {},
      store,
      clock: (): number => NOW,
    };
    const copilot = session('c2', { cwd: workspace, agent: 'copilot' });
    const merged = await resolveSnapshot(deps, {
      base: snapshot('c2'),
      session: copilot,
      agentId: 'c2',
      observed: [],
    });
    expect(merged.loaded.map((item) => item.path)).toContain(instructions);
    expect(merged.mcpServers).toStrictEqual([
      { name: 'docs', instructions: '' },
      { name: 'linear', instructions: '' },
    ]);
    // A transcript that names its servers keeps its own list.
    const named = await resolveSnapshot(deps, {
      base: snapshot('c2', { mcpServers: [{ name: 'own', instructions: 'x' }] }),
      session: copilot,
      agentId: 'c2',
      observed: [],
    });
    expect(named.mcpServers).toStrictEqual([{ name: 'own', instructions: 'x' }]);
  });

  it('puts hook observed loads into the snapshot and marks invoked skills', async () => {
    const { store, workspace, paths } = await setup();
    const extra = loaded(path.join(workspace, 'extra.md'));
    const base = snapshot('s1', {
      skills: [
        {
          name: 'tidy',
          source: 'user',
          path: null,
          listed: true,
          invoked: true,
          descriptionChars: 8,
        },
      ],
    });
    const merged = await resolveSnapshot(
      {
        paths,
        fs: createNodeFileSystem(),
        exec: recordingExec().exec,
        env: {},
        store,
        clock: () => NOW,
      },
      { base, session: session('s1', { cwd: workspace }), agentId: 'sub', observed: [extra] },
    );
    expect(merged.loaded).toStrictEqual([extra]);
    expect(merged.skills).toStrictEqual(base.skills);
  });

  it('honors claudeMdExcludes from user settings', async () => {
    const { store, workspace, paths } = await setup();
    await writeJson(paths.userSettings, { claudeMdExcludes: [path.join(workspace, 'CLAUDE.md')] });
    const merged = await resolveSnapshot(
      {
        paths,
        fs: createNodeFileSystem(),
        exec: recordingExec().exec,
        env: {},
        store,
        clock: () => NOW,
      },
      {
        base: snapshot('s1'),
        session: session('s1', { cwd: workspace }),
        agentId: 's1',
        observed: [],
      },
    );
    const skipped = merged.skipped.find((item) => item.path === path.join(workspace, 'CLAUDE.md'));
    expect(skipped?.code).toBe('excluded');
  });
});

describe('ContextViews', () => {
  it('lists sessions without resolving when no session is picked or the session is unknown', async () => {
    const { views, bus, onUpdate, calls } = await setup();
    bus.emit('session.upserted', session('s1', { title: 'One' }));
    expect(views.build({})).toStrictEqual({
      snapshot: null,
      sessions: [{ id: 's1', title: 'One' }],
    });
    expect(views.build({ sessionId: 'ghost' }).snapshot).toBeNull();
    await settle();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(calls).toStrictEqual([]);
  });

  it('resolves once per snapshot in the background and shows the result', async () => {
    const { views, bus, workspace, calls, onUpdate } = await setup();
    bus.emit('session.upserted', session('s1', { cwd: workspace, model: 'claude-x' }));
    const first = views.build({ sessionId: 's1' });
    expect(first.snapshot?.loaded).toStrictEqual([]);
    expect(first.snapshot?.model).toBe('claude-x');
    expect(first.snapshot?.at).toBe(NOW - 1000);
    expect(first.snapshot?.agentId).toBe('s1');
    expect(views.build({ sessionId: 's1' }).snapshot).toBe(first.snapshot);
    await waitFor(() => onUpdate.mock.calls.length > 0);
    expect(revParses(calls)).toBe(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const second = views.build({ sessionId: 's1' });
    expect(second.snapshot?.loaded.map((item) => item.path)).toContain(
      path.join(workspace, 'CLAUDE.md'),
    );
    expect(views.build({ sessionId: 's1' }).snapshot).toBe(second.snapshot);
    await settle(30);
    expect(revParses(calls)).toBe(1);
    bus.emit('context.updated', snapshot('s1', { systemPrompt: ['changed'] }));
    expect(views.build({ sessionId: 's1' }).snapshot?.systemPrompt).toStrictEqual(['changed']);
    await waitFor(() => onUpdate.mock.calls.length > 1);
    expect(revParses(calls)).toBe(2);
    expect(views.build({ sessionId: 's1' }).snapshot?.weights.length).toBeGreaterThan(0);
  });

  it('keys results by agent', async () => {
    const { views, bus, workspace, onUpdate } = await setup();
    bus.emit('session.upserted', session('s1', { cwd: workspace }));
    expect(views.build({ sessionId: 's1', agentId: 'sub' }).snapshot?.agentId).toBe('sub');
    await waitFor(() => onUpdate.mock.calls.length > 0);
    expect(views.build({ sessionId: 's1', agentId: 'sub' }).snapshot?.agentId).toBe('sub');
    expect(views.build({ sessionId: 's1' }).snapshot?.agentId).toBe('s1');
  });

  it('adds hook loads once and resolves again with them', async () => {
    const { views, bus, workspace, onUpdate } = await setup();
    bus.emit('session.upserted', session('s1', { cwd: workspace }));
    views.build({ sessionId: 's1' });
    await waitFor(() => onUpdate.mock.calls.length > 0);
    onUpdate.mockClear();
    const instruction = loaded(path.join(workspace, 'hooked.md'));
    const event = { sessionId: 's1', agentId: 's1', memoryType: 'Project', instruction };
    views.addObserved(event);
    views.addObserved(event);
    views.addObserved({ ...event, agentId: 'other' });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    views.build({ sessionId: 's1' });
    await waitFor(() => onUpdate.mock.calls.length > 2);
    expect(views.build({ sessionId: 's1' }).snapshot?.loaded).toStrictEqual([instruction]);
  });

  it('resolves again after clear', async () => {
    const { views, bus, workspace, calls, onUpdate } = await setup();
    bus.emit('session.upserted', session('s1', { cwd: workspace }));
    views.build({ sessionId: 's1' });
    await waitFor(() => onUpdate.mock.calls.length > 0);
    onUpdate.mockClear();
    views.clear();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    views.build({ sessionId: 's1' });
    await waitFor(() => onUpdate.mock.calls.length > 1);
    expect(revParses(calls)).toBe(2);
  });

  it('reports a failed resolve once and keeps the plain snapshot', async () => {
    const broken: FileSystem = {
      ...createNodeFileSystem(),
      kind: async (): Promise<null> => {
        await Promise.resolve();
        throw new Error('disk on fire');
      },
    };
    const { views, bus, workspace, onError, onUpdate } = await setup(broken);
    bus.emit('session.upserted', session('s1', { cwd: workspace }));
    views.build({ sessionId: 's1' });
    await waitFor(() => onUpdate.mock.calls.length > 0);
    expect(onError).toHaveBeenCalledWith('context', 'disk on fire');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(views.build({ sessionId: 's1' }).snapshot?.loaded).toStrictEqual([]);
    await settle(30);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
