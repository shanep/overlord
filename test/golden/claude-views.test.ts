// Golden snapshots of what the Fleet, agent detail and properties views get
// for Claude sessions. The app reads synthetic transcripts from a temp home
// with a fixed clock, and each view's state is compared with a checked-in
// JSON file under claude/. Phase 1 moves Claude behind the agent seams, and
// these files prove the views did not change.
//
// After a change that should alter a view, regenerate the files and review
// the diff: npm run -s test:related -- test/golden/claude-views.test.ts -u

import { utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PanelParams } from '../../src/core/app/host-port.js';
import { makeApp, makeEnv, settle } from '../../src/core/app/test-helpers/fixtures.js';
import { isArray } from '../../src/core/sync/json.js';
import {
  assistant,
  jsonl,
  makeSessionLayout,
  SESSION,
  sidechain,
  T0,
  text,
  thinking,
  toolResult,
  toolUse,
  usage,
  userPrompt,
  writeSubagent,
} from '../../src/core/transcripts/test-helpers/fixtures.js';
import type { ViewId } from '../../src/shared/protocol.js';

const MINUTE = 60_000;
/** The app's clock: a minute after the running session's last record. */
const CLOCK = T0 + 9 * MINUTE;
/** A second session in the same project with a tool call still open. */
const RUNNING = 'sess-0002';
/** The foreground Explore agent the first session spawns. */
const EXPLORER = 'explore1';

/** Pins a file's modified time, which the watcher compares with the clock. */
async function touch(file: string, at: number): Promise<void> {
  const when = new Date(at);
  await utimes(file, when, when);
}

/** The first session: reads a file, spawns an Explore agent that greps, then ends its turn. */
async function writeFinishedSession(claudeDir: string): Promise<void> {
  const layout = await makeSessionLayout(claudeDir, SESSION);
  await writeFile(
    layout.transcriptPath,
    jsonl([
      userPrompt('a-u1', 0, 'Find why the build is slow'),
      assistant({
        uuid: 'a-a1',
        at: 1000,
        messageId: 'msg-a1',
        stop: 'tool_use',
        usage: usage({
          input: 1200,
          output: 80,
          cacheRead: 3000,
          cacheCreation: 500,
          thinking: 20,
        }),
        content: [
          thinking('Look at the build config first'),
          text('Reading the build config.'),
          toolUse('toolu_read', 'Read', { file_path: '/work/demo/build.mjs' }),
          toolUse('toolu_agent', 'Agent', {
            subagent_type: 'Explore',
            description: 'Scan the imports',
            prompt: 'List slow imports',
          }),
        ],
      }),
      toolResult('a-u2', 2000, [{ toolUseId: 'toolu_read', text: 'export default {}' }]),
      toolResult('a-u3', 5000, [
        { toolUseId: 'toolu_agent', text: 'Two files import the whole SDK.' },
      ]),
      assistant({
        uuid: 'a-a2',
        at: 6000,
        messageId: 'msg-a2',
        usage: usage({ input: 300, output: 40, cacheRead: 4200 }),
        content: [text('The SDK import is the slow part.')],
      }),
    ]),
  );
  await writeSubagent(layout, {
    agentId: EXPLORER,
    meta: {
      agentType: 'Explore',
      description: 'Scan the imports',
      toolUseId: 'toolu_agent',
      spawnDepth: 1,
      requestShape: 'foreground',
    },
    records: [
      sidechain(EXPLORER, userPrompt('e-u1', 2100, 'List slow imports')),
      sidechain(
        EXPLORER,
        assistant({
          uuid: 'e-a1',
          at: 2500,
          messageId: 'msg-e1',
          stop: 'tool_use',
          usage: usage({ input: 400, output: 30 }),
          content: [toolUse('toolu_grep', 'Grep', { pattern: 'import' })],
        }),
      ),
      sidechain(
        EXPLORER,
        toolResult('e-u2', 3000, [{ toolUseId: 'toolu_grep', text: 'src/a.ts\nsrc/b.ts' }]),
      ),
      sidechain(
        EXPLORER,
        assistant({
          uuid: 'e-a2',
          at: 4000,
          messageId: 'msg-e2',
          usage: usage({ input: 500, output: 25 }),
          content: [text('Two files import the whole SDK.')],
        }),
      ),
    ],
  });
  await touch(layout.transcriptPath, T0 + 6000);
  await touch(layout.subagentsDir, T0 + 4000);
}

/** The second session: a Bash call that has not returned yet. */
async function writeRunningSession(claudeDir: string): Promise<void> {
  const layout = await makeSessionLayout(claudeDir, RUNNING);
  const mine = { sessionId: RUNNING };
  await writeFile(
    layout.transcriptPath,
    jsonl([
      userPrompt('b-u1', 8 * MINUTE, 'Run the tests', mine),
      assistant({
        uuid: 'b-a1',
        at: 8 * MINUTE + 1000,
        messageId: 'msg-b1',
        stop: 'tool_use',
        usage: usage({ input: 900, output: 15, cacheRead: 2000 }),
        content: [toolUse('toolu_bash', 'Bash', { command: 'npm test' })],
        extra: mine,
      }),
    ]),
  );
  await touch(layout.transcriptPath, T0 + 8 * MINUTE + 1000);
}

/** Keys in code unit order at every level, with any pid hidden, so the JSON is stable. */
function stable(value: unknown): unknown {
  if (isArray(value)) {
    return value.map((item) => stable(item));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const entries = Object.entries(value)
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, item]: [string, unknown]) => [
      key,
      key === 'pid' && typeof item === 'number' ? '<pid>' : stable(item),
    ]);
  return Object.fromEntries(entries);
}

async function viewsJson(
  views: readonly (readonly [ViewId, PanelParams])[],
): Promise<readonly string[]> {
  const env = await makeEnv();
  const claudeDir = path.dirname(env.paths.projectsDir);
  await writeFinishedSession(claudeDir);
  await writeRunningSession(claudeDir);
  const { app } = makeApp(env, { deps: { clock: () => CLOCK } });
  await app.start();
  await settle();
  return views.map(([view, params]) => {
    const json = JSON.stringify(stable(app.stateFor(view, params)), null, 2);
    return `${json.replaceAll(env.root, '<root>')}\n`;
  });
}

const CASES: readonly (readonly [string, ViewId, PanelParams])[] = [
  ['fleet', 'fleet', {}],
  ['agent-main', 'agent', { sessionId: SESSION }],
  ['agent-subagent', 'agent', { sessionId: SESSION, agentId: EXPLORER }],
  ['agent-running', 'agent', { sessionId: RUNNING }],
  ['properties', 'properties', { sessionId: SESSION }],
  ['properties-running', 'properties', { sessionId: RUNNING }],
];

describe('Claude view snapshots', () => {
  it('builds the same Fleet, agent and properties state from the fixtures', async () => {
    const outputs = await viewsJson(CASES.map(([, view, params]) => [view, params] as const));
    for (const [index, [name]] of CASES.entries()) {
      const output = outputs[index] ?? '';
      expect(output).not.toContain(os.homedir());
      expect(output).not.toContain(os.tmpdir());
      await expect(output).toMatchFileSnapshot(`claude/${name}.json`);
    }
  });

  it('starts every view from sessions the watcher found', async () => {
    const [fleet = ''] = await viewsJson([['fleet', {}]]);
    expect(fleet).toContain(`"id": "${SESSION}"`);
    expect(fleet).toContain(`"id": "${RUNNING}"`);
    expect(fleet).toContain(`"id": "${EXPLORER}"`);
  });
});
