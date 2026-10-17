import { describe, expect, it } from 'vitest';

import type { NormalizedHookEvent } from '../hooks/normalized.js';
import type { ConfigOverride } from '../knobs/facet.js';

import { COVER_MS, LaunchNotes, type LaunchNoteSources } from './launch-notes.js';

function sources(overrides: Partial<LaunchNoteSources> = {}): LaunchNoteSources & {
  clock: { now: number };
  waits: number[];
} {
  const clock = { now: 1000 };
  const waits: number[] = [];
  return {
    briefing: () => 'briefing',
    launchCheck: async (_cwd, _agent, waitMs): Promise<string | null> => {
      await Promise.resolve();
      waits.push(waitMs);
      return 'check';
    },
    peers: () => null,
    telemetry: async (): Promise<readonly ConfigOverride[]> => {
      await Promise.resolve();
      return [];
    },
    now: () => clock.now,
    ...overrides,
    clock,
    waits,
  };
}

function start(agent: string, cwd: string, sessionId = 'thr'): NormalizedHookEvent {
  return {
    agent,
    native: 'SessionStart',
    sessionId,
    subagentId: null,
    cwd,
    transcriptPath: null,
    timestamp: null,
    kind: 'session-start',
    source: 'new',
    model: null,
    title: null,
  };
}

describe('LaunchNotes', () => {
  it('gives a Codex launch its notes as developer_instructions', async () => {
    const notes = new LaunchNotes();
    const from = sources();
    notes.connect(from);
    expect(await notes.config('codex', '/w')).toStrictEqual([
      { key: ['developer_instructions'], value: 'briefing\n\ncheck' },
    ]);
    expect(from.waits).toStrictEqual([5000]);
    expect(await notes.args('codex', '/w')).toStrictEqual([
      '-c',
      String.raw`developer_instructions="briefing\n\ncheck"`,
    ]);
  });

  it('adds the telemetry export to a launch', async () => {
    const notes = new LaunchNotes();
    notes.connect(
      sources({
        briefing: () => null,
        launchCheck: async (): Promise<null> => {
          await Promise.resolve();
          return null;
        },
        telemetry: async (): Promise<readonly ConfigOverride[]> => {
          await Promise.resolve();
          return [{ key: ['otel', 'environment'], value: 'o' }];
        },
      }),
    );
    expect(await notes.config('codex', '/w')).toStrictEqual([
      { key: ['otel', 'environment'], value: 'o' },
    ]);
    expect(await notes.args('codex', '/w')).toStrictEqual(['-c', 'otel.environment="o"']);
  });

  it('leaves Claude Code to its hooks, with nothing to wait for', () => {
    const notes = new LaunchNotes();
    notes.connect(sources());
    expect(notes.config('claude-code', '/w')).toBeNull();
    expect(notes.args('claude-code', '/w')).toBeNull();
  });

  it('gives nothing before it is connected', async () => {
    expect(await new LaunchNotes().config('codex', '/w')).toStrictEqual([]);
  });

  it("covers the launched session's SessionStart hook once, and only for a while", async () => {
    const notes = new LaunchNotes();
    const from = sources();
    notes.connect(from);
    await notes.config('codex', '/w');
    expect(notes.isCovered(start('claude-code', '/w'))).toBe(false);
    expect(notes.isCovered(start('codex', '/w', 'a'))).toBe(true);
    expect(notes.isCovered(start('codex', '/w', 'a'))).toBe(true);
    expect(notes.isCovered(start('codex', '/w', 'b'))).toBe(false);
    await notes.config('codex', '/w');
    from.clock.now += COVER_MS + 1;
    expect(notes.isCovered(start('codex', '/w', 'c'))).toBe(false);
    expect(notes.isCovered({ ...start('codex', '/w', 'a'), kind: 'stop', lastMessage: null })).toBe(
      false,
    );
  });
});
