import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { titleSidecarPath } from '../transcripts/rename.js';

import { NO_TRANSCRIPT } from './actions-rename.js';
import type { TestApp } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, session, writeText } from './test-helpers/fixtures.js';

const FIRST_LINE = '{"type":"ai-title","aiTitle":"overlord-session-handoff","sessionId":"s1"}\n';

async function withTranscript(): Promise<{ readonly test: TestApp; readonly transcript: string }> {
  const env = await makeEnv();
  const test = makeApp(env);
  const transcript = await writeText(path.join(env.root, 'projects', 's1.jsonl'), FIRST_LINE);
  test.bus.emit(
    'session.upserted',
    session('s1', { title: 'overlord-session-handoff', transcriptPath: transcript }),
  );
  return { test, transcript };
}

describe('renameSession', () => {
  it('saves the new name where Claude Code keeps it', async () => {
    const { test, transcript } = await withTranscript();
    test.env.host.inputAnswers.push('  Fleet   rename button ');
    await test.app.dispatch({ type: 'renameSession', sessionId: 's1' }, {});
    expect(test.env.host.inputs).toStrictEqual([
      { prompt: 'Session name', value: 'overlord-session-handoff' },
    ]);
    expect(await readFile(transcript, 'utf8')).toBe(
      `${FIRST_LINE}{"type":"custom-title","customTitle":"Fleet rename button","sessionId":"s1"}\n`,
    );
    const sidecar = await readFile(titleSidecarPath(transcript, 's1'), 'utf8');
    expect(JSON.parse(sidecar)).toStrictEqual({ customTitle: 'Fleet rename button' });
  });

  it('leaves the session alone when cancelled, blank or unchanged', async () => {
    const { test, transcript } = await withTranscript();
    test.env.host.inputAnswers.push(null, '  ', 'overlord-session-handoff');
    for (let round = 0; round < 3; round += 1) {
      await test.app.dispatch({ type: 'renameSession', sessionId: 's1' }, {});
    }
    expect(await readFile(transcript, 'utf8')).toBe(FIRST_LINE);
  });

  it('says so for a session with no transcript yet', async () => {
    const env = await makeEnv();
    const test = makeApp(env);
    test.bus.emit('session.upserted', session('s2'));
    await test.app.dispatch({ type: 'renameSession', sessionId: 's2' }, {});
    expect(test.env.host.infos).toStrictEqual([NO_TRANSCRIPT]);
    expect(test.env.host.inputs).toStrictEqual([]);
  });
});
