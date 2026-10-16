import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EventBus } from '../../bus.js';
import { OverlordStore } from '../../store/store.js';
import { SessionPlaces } from '../places.js';
import {
  immediateScheduler,
  makeEnv,
  makeApp,
  session,
  writeJson,
} from '../test-helpers/fixtures.js';

import { activitySessions } from './activity.js';

async function placesWith(
  entries: readonly Record<string, unknown>[],
): Promise<{ places: SessionPlaces; store: OverlordStore; bus: EventBus }> {
  const env = await makeEnv();
  for (const entry of entries) {
    await writeJson(path.join(env.paths.sessionsDir, `${String(entry['pid'])}.json`), entry);
  }
  const places = new SessionPlaces({
    paths: env.paths,
    exec: async (): Promise<{ stdout: string }> => {
      await Promise.resolve();
      return { stdout: '' };
    },
    isAlive: (): boolean => true,
    terminalPids: async (): Promise<readonly number[]> => {
      await Promise.resolve();
      return [];
    },
    keep: async (): Promise<void> => {
      await Promise.resolve();
    },
    onChange: (): void => {
      // The test reads the places directly.
    },
    onStatus: (): void => {
      // Same as onChange.
    },
    report: (): void => {
      // Nothing here fails.
    },
  });
  await places.refresh();
  const bus = new EventBus();
  return { places, store: new OverlordStore(bus, { scheduler: immediateScheduler }), bus };
}

describe('activitySessions', () => {
  it('titles each live session from the transcript, the registry, the folder or the id', async () => {
    const { places, store, bus } = await placesWith([
      { pid: 1, sessionId: 'titled-session', kind: 'bg', cwd: '/w/one' },
      { pid: 2, sessionId: 'named-session', kind: 'bg', name: 'Named' },
      { pid: 3, sessionId: 'folder-session', kind: 'bg', cwd: '/w/three' },
      { pid: 4, sessionId: 'bare-session-id', kind: 'bg' },
      { pid: 5, sessionId: 'untitled-session', kind: 'bg' },
    ]);
    bus.emit(
      'session.upserted',
      session('titled-session', { title: 'Fix the build', cwd: '/w/x' }),
    );
    bus.emit('session.upserted', session('untitled-session', { title: '', cwd: '/w/five' }));
    const refs = activitySessions(places, store).toSorted((left, right) => left.pid - right.pid);
    expect(refs.map((ref) => [ref.pid, ref.title, ref.cwd, ref.place])).toStrictEqual([
      [1, 'Fix the build', '/w/one', 'background'],
      [2, 'Named', '', 'background'],
      [3, 'three', '/w/three', 'background'],
      [4, 'bare-ses', '', 'background'],
      [5, 'five', '/w/five', 'background'],
    ]);
  });

  it('marks a session with no known place', async () => {
    const { places, store } = await placesWith([
      { pid: 9, sessionId: 'odd-session', kind: 'other' },
    ]);
    expect(activitySessions(places, store)[0]?.place).toBeNull();
  });
});

describe('the activity view in the app', () => {
  it('starts sampling on the first read and stops on dispose', async () => {
    const env = await makeEnv();
    const { app, intervals } = makeApp(env);
    const message = app.stateFor('activity', {});
    expect(message.view).toBe('activity');
    expect(intervals.some((entry) => entry.ms === 2000 && !entry.stopped)).toBe(true);
    await app.dispose();
    expect(intervals.filter((entry) => entry.ms === 2000).every((entry) => entry.stopped)).toBe(
      true,
    );
  });
});
