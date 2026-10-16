import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../../shared/model.js';
import type { TranscriptDigest } from '../transcripts/digest.js';
import { assistant, jsonl, text, userPrompt } from '../transcripts/test-helpers/fixtures.js';

import type { CombineSource } from './combine.js';
import { combinePrompt, CUT_NOTE, PROMPT_LIMIT, TAB_NAME } from './combine.js';
import type { ExecCall, TestApp, TestEnv } from './test-helpers/fixtures.js';
import {
  makeApp,
  makeEnv,
  NOW,
  ok,
  session,
  writeJson,
  writeText,
} from './test-helpers/fixtures.js';

const EMPTY: TranscriptDigest = {
  title: null,
  prompts: [],
  files: [],
  commits: [],
  pushes: [],
  lastReply: null,
};

function source(
  overrides: Partial<SessionSummary>,
  digest: Partial<TranscriptDigest> = {},
): CombineSource {
  return { session: session('s1', overrides), digest: { ...EMPTY, ...digest } };
}

describe('combinePrompt', () => {
  it('tells the new session what to do, then gives one section per session', () => {
    const prompt = combinePrompt([
      source(
        {
          id: 'a',
          cwd: '/r/a',
          gitBranch: 'overlord/a',
          state: 'done',
          transcriptPath: '/t/a.jsonl',
        },
        {
          title: 'Group the fleet',
          prompts: ['Group the fleet\n  by   project', 'yes'],
          files: ['/r/a/book.ts'],
          commits: ['1a2b3c4 Group the fleet by project'],
          pushes: ['0000000..1a2b3c4 HEAD -> master'],
          lastReply: 'Landed it.',
        },
      ),
      source({ id: 'b', title: '', cwd: '/r/b', state: 'running' }),
    ]);
    expect(prompt).toBe(
      [
        'This session picks up from 2 earlier Claude Code sessions that I combined in Overlord. Below is what I asked each one, what it changed and where it left off. Read it, check the current state of the code (git log and git status are a good start), then give me a short summary of where things stand and wait for what I want next. Each full transcript is listed if you need more.',
        '',
        '## Session 1: Group the fleet',
        '- Session id: a',
        '- Folder: /r/a',
        '- Branch: overlord/a',
        '- State: done',
        '- Transcript: /t/a.jsonl',
        '',
        '### What I asked',
        '1. Group the fleet by project',
        '2. yes',
        '',
        '### Commits',
        '- 1a2b3c4 Group the fleet by project',
        '',
        '### Pushes',
        '- 0000000..1a2b3c4 HEAD -> master',
        '',
        '### Files edited with the Edit and Write tools',
        '- /r/a/book.ts',
        '',
        '### Its last reply',
        'Landed it.',
        '',
        '## Session 2: b',
        '- Session id: b',
        '- Folder: /r/b',
        '- State: running',
        '',
        '### What I asked',
        '(none found)',
        '',
        '### Its last reply',
        '(none)',
      ].join('\n'),
    );
  });

  it('names a session by its fleet title when the transcript has none', () => {
    expect(combinePrompt([source({ title: 'Fix the parser' })])).toContain(
      '## Session 1: Fix the parser',
    );
  });

  it('shows the first and latest prompts of a long session, each cut short', () => {
    const prompts = Array.from({ length: 30 }, (_, index) => `prompt ${String(index + 1)}`);
    prompts[0] = 'x'.repeat(600);
    const prompt = combinePrompt([source({}, { prompts })]);
    expect(prompt).toContain(`1. ${'x'.repeat(500)}...\n2. prompt 2`);
    expect(prompt).toContain('5. prompt 5\n(10 more not shown)\n16. prompt 16');
    expect(prompt).toContain('30. prompt 30');
    expect(prompt).not.toContain('15. prompt 15');
  });

  it('caps long lists and the last reply', () => {
    const files = Array.from({ length: 45 }, (_, index) => `/f${String(index)}`);
    const prompt = combinePrompt([source({}, { files, lastReply: 'y'.repeat(3100) })]);
    expect(prompt).toContain('- /f39\n- (5 more)');
    expect(prompt).not.toContain('/f40');
    expect(prompt).toContain(`${'y'.repeat(3000)}...`);
  });

  it('cuts the whole prompt to fit on a command line', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      source({ id: `s${String(index)}` }, { lastReply: 'z'.repeat(3000) }),
    );
    const prompt = combinePrompt(many);
    expect(prompt).toHaveLength(PROMPT_LIMIT);
    expect(prompt.endsWith(CUT_NOTE)).toBe(true);
  });
});

/** Answers `claude agents` with nothing, so a session is live only through the registry. */
function agentsResponder(call: ExecCall): ReturnType<typeof ok> | undefined {
  return call.args[0] === 'agents' ? ok('[]') : undefined;
}

interface World {
  readonly test: TestApp;
  readonly env: TestEnv;
  readonly folder: string;
}

async function world(live: readonly number[] = [], repo = false): Promise<World> {
  const env = await makeEnv({ workspace: true });
  const folder = path.join(env.root, 'notes');
  await mkdir(folder, { recursive: true });
  // With repo set, git calls the session folder a repository, so it is a project of its own.
  const gitRepo = (call: ExecCall): ReturnType<typeof ok> | undefined =>
    repo && call.args.includes('--git-common-dir') && call.options.cwd === folder
      ? ok(`${folder}/.git\n${folder}\n`)
      : undefined;
  const test = makeApp(env, {
    deps: { isAlive: (pid) => live.includes(pid) },
    responders: [agentsResponder, gitRepo],
  });
  return { test, env, folder };
}

async function addSession(
  w: World,
  id: string,
  prompt: string,
  overrides: Partial<SessionSummary> = {},
): Promise<SessionSummary> {
  const transcriptPath = await writeText(
    path.join(w.env.root, 'transcripts', `${id}.jsonl`),
    jsonl([
      userPrompt(`${id}-u`, 0, prompt),
      assistant({ uuid: `${id}-a`, at: 0, messageId: `${id}-m`, content: [text(`did ${id}`)] }),
    ]),
  );
  const summary = session(id, { cwd: w.folder, transcriptPath, ...overrides });
  w.test.bus.emit('session.upserted', summary);
  return summary;
}

async function liveIn(env: TestEnv, pid: number, sessionId: string): Promise<void> {
  await writeJson(path.join(env.paths.sessionsDir, `${String(pid)}.json`), {
    pid,
    sessionId,
    cwd: '/x',
  });
}

function started(w: World): readonly string[] {
  return w.env.host.terminals.map((terminal) => terminal.name);
}

describe('combineSessions', () => {
  it('explains a session it cannot combine', async () => {
    const w = await world();
    w.test.bus.emit('session.upserted', session('bare'));
    await w.test.app.dispatch({ type: 'combineSessions', sessionId: 'bare' }, {});
    await w.test.app.dispatch({ type: 'combineSessions', sessionId: 'nobody' }, {});
    await addSession(w, 'alone', 'hi');
    await w.test.app.dispatch({ type: 'combineSessions', sessionId: 'alone' }, {});
    expect(w.env.host.infos).toStrictEqual([
      'Overlord has no transcript for that session, so it cannot combine it.',
      'Overlord has no transcript for that session, so it cannot combine it.',
      'There is no other session with a transcript to combine it with.',
    ]);
    expect(w.env.host.picks).toStrictEqual([]);
  });

  it('offers the same project first, then the most recent, and starts nothing when cancelled', async () => {
    const w = await world([], true);
    await addSession(w, 'anchor', 'one', { title: 'Anchor' });
    await addSession(w, 'old', 'two', { title: 'Old', updatedAt: NOW - 5000, state: 'done' });
    await addSession(w, 'new', 'three', { title: '', cwd: '/elsewhere', updatedAt: NOW });
    w.test.bus.emit('session.upserted', session('no-transcript'));
    await w.test.app.runtime.projects.refresh([w.folder, '/elsewhere']);
    w.env.host.pickManyAnswers.push(null, []);
    await w.test.app.dispatch({ type: 'combineSessions', sessionId: 'anchor' }, {});
    await w.test.app.dispatch({ type: 'combineSessions', sessionId: 'anchor' }, {});
    expect(w.env.host.picks[0]).toStrictEqual({
      placeholder: 'Combine "Anchor" with',
      items: [
        { id: 'old', label: 'Old', description: 'notes · done' },
        { id: 'new', label: '/elsewhere', description: 'No project · running' },
      ],
    });
    expect(started(w)).toStrictEqual([]);
  });

  it('starts one session from a digest of all of them, oldest first, in the anchor folder', async () => {
    const w = await world();
    await addSession(w, 'later', 'build it', { title: '', startedAt: NOW - 100, state: 'done' });
    await addSession(w, 'first', 'plan it', { startedAt: NOW - 900, state: 'done' });
    w.env.host.pickManyAnswers.push(['first']);
    await w.test.app.dispatch({ type: 'combineSessions', sessionId: 'later' }, {});
    expect(w.env.host.picks[0]?.placeholder).toBe('Combine this session with');
    const terminal = w.env.host.terminals.at(-1);
    expect(terminal).toMatchObject({ name: TAB_NAME, cwd: w.folder });
    const [flag, id, prompt = ''] = terminal?.args ?? [];
    expect([flag, id]).toStrictEqual(['--session-id', terminal?.sessionId]);
    expect(prompt.indexOf('1. plan it')).toBeLessThan(prompt.indexOf('1. build it'));
    expect(prompt).toContain('## Session 2: later');
    expect(prompt).toContain('did first');
    // Both were done, so there is nothing to stop.
    expect(w.env.host.questions).toStrictEqual([]);
  });

  it('starts in the workspace when the anchor folder is gone', async () => {
    const w = await world();
    await addSession(w, 'gone', 'hi', { cwd: path.join(w.env.root, 'missing'), state: 'done' });
    await addSession(w, 'other', 'there', { state: 'done' });
    w.env.host.pickManyAnswers.push(['other']);
    await w.test.app.dispatch({ type: 'combineSessions', sessionId: 'gone' }, {});
    expect(w.env.host.terminals.at(-1)?.cwd).toBe(w.env.host.workspace);
  });

  it('stops the running ones after a yes, and says which it could not reach', async () => {
    const w = await world([123]);
    await liveIn(w.env, 123, 'live');
    await addSession(w, 'live', 'a');
    await addSession(w, 'away', 'b', { state: 'idle' });
    await addSession(w, 'finished', 'c', { state: 'done' });
    w.env.host.pickManyAnswers.push(['away', 'finished']);
    w.env.host.confirmAnswers.push(true);
    await w.test.app.dispatch({ type: 'combineSessions', sessionId: 'live' }, {});
    expect(w.env.host.questions).toStrictEqual([
      {
        message:
          'Stop the 2 combined sessions that are still running? The new session starts from their digest, and their transcripts stay.',
        action: 'Stop',
      },
    ]);
    expect(w.test.kills).toStrictEqual([{ pid: 123, signal: 'SIGTERM' }]);
    expect(w.env.host.infos).toStrictEqual([
      '1 of them is not running on this machine, so Overlord left it alone.',
    ]);
  });

  it('names a single running session, and leaves it alone after a no', async () => {
    const w = await world([123]);
    await liveIn(w.env, 123, 'live');
    await addSession(w, 'live', 'a', { title: 'Live one' });
    await addSession(w, 'finished', 'b', { state: 'done' });
    w.env.host.pickManyAnswers.push(['finished']);
    await w.test.app.dispatch({ type: 'combineSessions', sessionId: 'live' }, {});
    expect(w.env.host.questions[0]?.message).toBe(
      'Stop "Live one"? The new session starts from its digest, and its transcript stays.',
    );
    expect(w.test.kills).toStrictEqual([]);
  });

  it('stops every running one it can reach without a word, and reads a lost transcript as empty', async () => {
    const w = await world([123]);
    await liveIn(w.env, 123, 'live');
    await addSession(w, 'live', 'a');
    await addSession(w, 'lost', 'b', {
      state: 'done',
      transcriptPath: path.join(w.env.root, 'gone.jsonl'),
    });
    w.env.host.pickManyAnswers.push(['lost']);
    w.env.host.confirmAnswers.push(true);
    await w.test.app.dispatch({ type: 'combineSessions', sessionId: 'live' }, {});
    expect(w.test.kills).toStrictEqual([{ pid: 123, signal: 'SIGTERM' }]);
    expect(w.env.host.infos).toStrictEqual([]);
    expect(w.env.host.terminals.at(-1)?.args.at(-1)).toContain('## Session 2: title lost');
  });

  it('says when none of the running ones are on this machine', async () => {
    const w = await world();
    await addSession(w, 'one', 'a');
    await addSession(w, 'two', 'b');
    w.env.host.pickManyAnswers.push(['two']);
    w.env.host.confirmAnswers.push(true);
    await w.test.app.dispatch({ type: 'combineSessions', sessionId: 'one' }, {});
    expect(w.env.host.infos).toStrictEqual([
      '2 of them are not running on this machine, so Overlord left them alone.',
    ]);
  });
});
