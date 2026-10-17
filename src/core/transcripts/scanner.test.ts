import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionAccumulator } from './accumulator.js';
import { ingestLines, loadSession, scanSessions } from './scanner.js';
import type { SessionLayout } from './test-helpers/fixtures.js';
import {
  assistant,
  jsonl,
  makeSessionLayout,
  makeTemporaryDirectory,
  removeDir,
  SESSION,
  sidechain,
  T0,
  text,
  toolResult,
  toolUse,
  userPrompt,
  writeSubagent,
} from './test-helpers/fixtures.js';

import * as api from './index.js';

const SECOND = 1000;

async function setMtime(target: string, ms: number): Promise<void> {
  const when = new Date(ms);
  await utimes(target, when, when);
}

describe('scanSessions', () => {
  let root = '';
  let layout: SessionLayout;

  beforeEach(async () => {
    root = await makeTemporaryDirectory();
    layout = await makeSessionLayout(root);
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it('gives nothing for a missing projects dir', async () => {
    expect(await scanSessions(path.join(root, 'missing'))).toStrictEqual([]);
  });

  it('lists session files newest first with size and mtime', async () => {
    await writeFile(layout.transcriptPath, 'abc\n');
    await setMtime(layout.transcriptPath, T0);
    const otherProject = path.join(layout.projectsDir, '-work-other');
    await mkdir(otherProject);
    const newer = path.join(otherProject, 'sess-0002.jsonl');
    await writeFile(newer, '');
    await setMtime(newer, T0 + 5 * SECOND);
    await writeFile(path.join(layout.projectDir, 'notes.txt'), 'skip');
    await mkdir(path.join(layout.projectDir, 'memory'));
    await writeFile(path.join(layout.projectsDir, 'stray.jsonl'), 'skip');
    await symlink(path.join(root, 'nowhere.jsonl'), path.join(layout.projectDir, 'dangling.jsonl'));

    expect(await scanSessions(layout.projectsDir)).toStrictEqual([
      {
        sessionId: 'sess-0002',
        projectDir: '-work-other',
        transcriptPath: newer,
        sessionDir: path.join(otherProject, 'sess-0002'),
        mtimeMs: T0 + 5 * SECOND,
        size: 0,
      },
      {
        sessionId: SESSION,
        projectDir: '-work-demo',
        transcriptPath: layout.transcriptPath,
        sessionDir: layout.sessionDir,
        mtimeMs: T0,
        size: 4,
      },
    ]);
  });

  it('follows symlinked transcripts', async () => {
    const real = path.join(root, 'real.jsonl');
    await writeFile(real, 'x\n');
    await symlink(real, layout.transcriptPath);
    const [info] = await scanSessions(layout.projectsDir);
    expect(info?.sessionId).toBe(SESSION);
    expect(info?.size).toBe(2);
  });

  it('counts a newer subagents folder as session activity', async () => {
    await writeFile(layout.transcriptPath, '');
    await setMtime(layout.transcriptPath, T0);
    await mkdir(layout.subagentsDir, { recursive: true });
    await setMtime(layout.subagentsDir, T0 + 9 * SECOND);
    const [info] = await scanSessions(layout.projectsDir);
    expect(info?.mtimeMs).toBe(T0 + 9 * SECOND);
    await setMtime(layout.subagentsDir, T0 - 9 * SECOND);
    const [again] = await scanSessions(layout.projectsDir);
    expect(again?.mtimeMs).toBe(T0);
  });
});

describe('ingestLines', () => {
  it('skips lines that are not records', () => {
    const accumulator = new SessionAccumulator({ sessionId: 's' });
    const results = ingestLines(
      accumulator,
      ['', '{bad', JSON.stringify(userPrompt('u', 0, 'hi'))],
      'other',
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.agentId).toBe('other');
    expect(accumulator.feed('other')).toHaveLength(1);
  });
});

describe('loadSession', () => {
  let root = '';
  let layout: SessionLayout;

  beforeEach(async () => {
    root = await makeTemporaryDirectory();
    layout = await makeSessionLayout(root);
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it('reads the main transcript and every subagent with its meta', async () => {
    await writeFile(
      layout.transcriptPath,
      jsonl([
        userPrompt('u1', 0, 'start'),
        assistant({
          uuid: 'a1',
          at: 10,
          messageId: 'm1',
          stop: 'tool_use',
          content: [toolUse('toolu_1', 'Agent')],
        }),
        toolResult('u2', 50, [{ toolUseId: 'toolu_1', text: 'done' }]),
      ]),
    );
    await writeSubagent(layout, {
      agentId: 'x1',
      meta: {
        agentType: 'Explore',
        description: 'look',
        toolUseId: 'toolu_1',
        spawnDepth: 1,
        requestShape: 'foreground',
      },
      records: [
        sidechain('x1', userPrompt('s1', 20, 'look')),
        sidechain('x1', assistant({ uuid: 's2', at: 30, messageId: 'm2', content: [text('ok')] })),
      ],
    });
    await writeSubagent(layout, {
      agentId: 'w1',
      meta: null,
      subdir: 'workflows/wf_1',
      records: [],
    });

    const accumulator = await loadSession(
      { ...layout, sessionId: SESSION },
      { runningWindowMs: 1 },
    );
    expect(accumulator.sessionId).toBe(SESSION);
    expect(accumulator.transcriptPath).toBe(layout.transcriptPath);
    const agents = accumulator.agents(T0 + 100);
    expect(
      agents.map((agent) => [agent.id, agent.parentAgentId, agent.agentType, agent.state]),
    ).toStrictEqual([
      [SESSION, null, 'main', 'unfinished'],
      ['x1', SESSION, 'Explore', 'done'],
      ['w1', SESSION, 'unknown', 'unknown'],
    ]);
    expect(agents[1]?.transcriptPath).toBe(path.join(layout.subagentsDir, 'agent-x1.jsonl'));
    expect(accumulator.requests().map((item) => item.messageId)).toStrictEqual(['m1', 'm2']);
  });

  it('gives an empty session for a missing transcript', async () => {
    const accumulator = await loadSession({ ...layout, sessionId: SESSION });
    expect(accumulator.summary(T0).state).toBe('unknown');
    expect(accumulator.agents(T0)).toHaveLength(1);
  });
});

describe('index', () => {
  it('exports the public API', () => {
    expect(Object.keys(api).toSorted((left, right) => left.localeCompare(right))).toStrictEqual([
      'DEFAULT_PRICES',
      'estimateCost',
      'findPrice',
      'IncrementalReader',
      'LineSplitter',
      'listSubagentFiles',
      'loadSession',
      'parseTranscriptLine',
      'readAllLines',
      'readSubagentMeta',
      'scanSessions',
      'SessionAccumulator',
      'TranscriptWatcher',
    ]);
  });
});
