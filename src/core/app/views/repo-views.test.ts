import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../../bus.js';
import { OverlordStore } from '../../store/store.js';
import { git, isolatedExec, repoWith } from '../../sync/test-helpers/fixtures.js';
import { toSurfacesExec } from '../process.js';
import { writeImport } from '../storage.js';
import {
  immediateScheduler,
  makeEnv,
  NOW,
  ok,
  recordingExec,
  session,
  writeText,
} from '../test-helpers/fixtures.js';

import { configRepoDir, connectedRoot, emptyConfig, loadConfig } from './config.js';
import { buildSessions, EMPTY_SESSIONS, loadSessions, transcriptRow } from './sessions.js';

function store(bus: EventBus): OverlordStore {
  return new OverlordStore(bus, { scheduler: immediateScheduler });
}

describe('sessions view', () => {
  it('builds a transcript row from file data, preferring what the store knows', () => {
    const info = {
      sessionId: 'abcdef0123456789',
      projectDir: '-work',
      transcriptPath: '/p/abc.jsonl',
      sessionDir: '/p/abc',
      mtimeMs: 77,
      size: 1,
    };
    expect(transcriptRow(info)).toStrictEqual({
      id: 'abcdef0123456789',
      surface: 'cli',
      title: 'Session abcdef01',
      cwd: null,
      updatedAt: 77,
      archived: false,
      handoffs: ['resume-local', 'open-desktop', 'start-cloud', 'remote-control'],
    });
    const known = session('abcdef0123456789', {
      surface: 'desktop-code',
      title: 'Known',
      cwd: '/w',
    });
    expect(transcriptRow(info, known)).toStrictEqual({
      id: 'abcdef0123456789',
      surface: 'desktop-code',
      title: 'Known',
      cwd: '/w',
      updatedAt: 77,
      archived: false,
      handoffs: ['resume-local', 'open-desktop'],
    });
  });

  it('lists transcripts, live processes and the stored claude.ai import', async () => {
    const env = await makeEnv();
    const bus = new EventBus();
    const sessionsStore = store(bus);
    bus.emit('session.upserted', session('live-one', { title: 'Live title', cwd: '/live' }));
    await writeText(path.join(env.paths.projectsDir, '-live', 'live-one.jsonl'), '');
    await writeText(path.join(env.paths.projectsDir, '-old', 'old-one.jsonl'), '');
    const importFile = path.join(env.storageDir, 'claude-ai.json');
    await writeImport(importFile, {
      importedAt: 5,
      sessions: [
        {
          id: 'chat',
          surface: 'claude-ai',
          title: 'A chat',
          cwd: null,
          updatedAt: 1,
          archived: false,
          handoffs: [],
        },
      ],
    });
    const { exec, calls } = recordingExec((call) =>
      call.command === 'my-claude' ? ok('[]') : undefined,
    );
    const report = vi.fn<(source: string, message: string) => void>();
    const data = await loadSessions({
      paths: env.paths,
      exec: toSurfacesExec(exec),
      isAlive: () => false,
      claudeBin: 'my-claude',
      store: sessionsStore,
      clock: () => NOW,
      importFile,
      report,
    });
    expect(calls.map((call) => [call.command, ...call.args])).toStrictEqual([
      ['my-claude', 'agents', '--json'],
    ]);
    expect(data.importedAt).toBe(5);
    const byId = new Map(data.sessions.map((row) => [row.id, row]));
    expect(byId.get('live-one')?.title).toBe('Live title');
    expect(byId.get('live-one')?.cwd).toBe('/live');
    expect(byId.get('old-one')?.title).toBe('Session old-one');
    expect(byId.get('chat')?.surface).toBe('claude-ai');
    expect(data.sessions).toHaveLength(3);
    expect(report).not.toHaveBeenCalled();
    expect(buildSessions(data)).toStrictEqual({ sessions: data.sessions, claudeAiImportedAt: 5 });
    expect(EMPTY_SESSIONS).toStrictEqual({ sessions: [], importedAt: null });
  });

  it('reports source errors and a broken import file and keeps going', async () => {
    const env = await makeEnv();
    const importFile = await writeText(path.join(env.storageDir, 'claude-ai.json'), '{bad');
    const { exec } = recordingExec();
    const report = vi.fn<(source: string, message: string) => void>();
    const data = await loadSessions({
      paths: env.paths,
      exec: toSurfacesExec(exec),
      isAlive: () => false,
      claudeBin: 'claude',
      store: store(new EventBus()),
      clock: () => NOW,
      importFile,
      report,
    });
    expect(data).toStrictEqual({ sessions: [], importedAt: null });
    expect(report.mock.calls).toStrictEqual([
      ['sessions', `${importFile} is not valid JSON`],
      ['sessions', 'claude-agents: claude failed: fake failure'],
    ]);
  });
});

describe('config view', () => {
  it('expands ~ in the configured path', () => {
    expect(configRepoDir('~/.claude-config', '/home/me')).toBe(
      path.join('/home/me', '.claude-config'),
    );
    expect(configRepoDir('/abs/repo', '/home/me')).toBe('/abs/repo');
  });

  it('is empty and not connected without a clone', async () => {
    const env = await makeEnv();
    const { exec } = recordingExec();
    const dir = path.join(env.home, '.claude-config');
    await expect(connectedRoot(exec, dir)).resolves.toBeNull();
    const state = await loadConfig({ paths: env.paths, exec, repoDir: dir, workspace: null });
    expect(state.repo).toStrictEqual({
      connected: false,
      remote: null,
      path: dir,
      ahead: 0,
      behind: 0,
      dirty: 0,
    });
    expect(state.items.every((item) => item.scope === 'built-in')).toBe(true);
    expect(emptyConfig(null).repo.path).toBeNull();
    expect(emptyConfig(null).items).toStrictEqual([]);
  });

  it('only connects when the folder is the top of a work tree', async () => {
    const exec = isolatedExec();
    const repo = await repoWith(exec, { 'overlord.json': '{"version":1}\n' });
    const inner = path.join(repo, 'inner');
    await mkdir(inner);
    await expect(connectedRoot(exec, repo)).resolves.toBe(await realpath(repo));
    await expect(connectedRoot(exec, inner)).resolves.toBeNull();
  });

  it('reports remote, ahead, behind and dirty counts for a connected clone', async () => {
    const env = await makeEnv();
    const exec = isolatedExec();
    const repo = await repoWith(exec, { 'a.txt': 'a\n' });
    await git(exec, repo, ['remote', 'add', 'origin', 'git@github.com:me/claude-config.git']);
    await writeText(path.join(repo, 'b.txt'), 'b\n');
    await writeText(path.join(repo, 'a.txt'), 'changed\n');
    await writeText(env.paths.userClaudeMd, '# me\n');
    const state = await loadConfig({ paths: env.paths, exec, repoDir: repo, workspace: null });
    expect(state.repo).toStrictEqual({
      connected: true,
      remote: 'git@github.com:me/claude-config.git',
      path: repo,
      ahead: 0,
      behind: 0,
      dirty: 2,
    });
    expect(state.items.find((item) => item.kind === 'claude-md')?.status).toBe('local-only');
  });
});
