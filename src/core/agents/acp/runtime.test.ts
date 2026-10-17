// Drives the ACP runtime against test/fake-agents/acp/fake-acp.mjs, which
// replays the recorded Copilot CLI exchange or a synthetic script and records
// what the runtime sent.
// cspell:words Rzvlrfumod

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { COPILOT } from '../../../shared/agents.js';
import type { PermissionRequest } from '../../../shared/model.js';
import { EventBus } from '../../bus.js';
import { errorMessage } from '../../harness/events.js';
import { PermissionInbox } from '../../harness/inbox.js';
import { AgentSession } from '../../harness/session.js';
import type { AgentEvent } from '../shared/events.js';
import type {
  AgentRun,
  StartOptions,
  ToolPermissionContext,
  ToolPermissionResult,
} from '../shared/runtime.js';

import { flagArgs } from './client.js';
import { acpRuntime, type AcpAgentSpec } from './runtime.js';

const FAKE_DIR = fileURLToPath(new URL('../../../../test/fake-agents/acp/', import.meta.url));
const FAKE = path.join(FAKE_DIR, 'fake-acp.mjs');
const COPILOT_ACP = fileURLToPath(
  new URL('../../../../test/fixtures/copilot/1.0.89/acp/06-acp.jsonl', import.meta.url),
);
const RECORDED_ID = '314df6e1-afd1-4b9c-bdf3-7cf94861398e';
const AGENT_MODE = 'https://agentclientprotocol.com/protocol/session-modes#agent';
const TIMEOUT = 20_000;
const WAIT = { timeout: 10_000 };

function script(name: string): string {
  return path.join(FAKE_DIR, 'scripts', `${name}.jsonl`);
}

interface Asked {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly context: ToolPermissionContext;
}

type Decide = (asked: Asked) => ToolPermissionResult;

interface Setup {
  readonly proc?: string;
  readonly exit?: number;
  readonly decide?: Decide;
  readonly start?: Partial<StartOptions>;
  readonly spec?: Partial<AcpAgentSpec>;
}

interface Fake {
  readonly run: AgentRun;
  readonly events: AgentEvent[];
  readonly asked: Asked[];
  /** The run's error message, or null when it ended cleanly. */
  readonly finished: Promise<string | null>;
  /** What the runtime sent, as the fake recorded it. */
  readonly sent: () => unknown[];
}

const deny: Decide = () => ({ behavior: 'deny', message: 'Denied from Overlord' });

function startFake(scriptPath: string, setup: Setup = {}): Fake {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overlord-acp-'));
  const record = path.join(dir, 'record.jsonl');
  const events: AgentEvent[] = [];
  const asked: Asked[] = [];
  const decide = setup.decide ?? deny;
  const runtime = acpRuntime({
    command: process.execPath,
    args: [FAKE],
    env: {
      FAKE_ACP_SCRIPT: scriptPath,
      FAKE_ACP_PROC: setup.proc ?? 'A',
      FAKE_ACP_RECORD: record,
      FAKE_ACP_EXIT: String(setup.exit ?? 0),
    },
    ...setup.spec,
  });
  const run = runtime.start({
    cwd: dir,
    sessionId: 'overlord-picked',
    resumeId: null,
    fork: false,
    env: { PATH: process.env['PATH'] ?? '' },
    model: null,
    effort: null,
    permissionMode: null,
    extraArgs: {},
    maxBudgetUsd: null,
    executablePath: null,
    noMcp: false,
    canUseTool: async (name, input, context) => {
      const question = { name, input, context };
      asked.push(question);
      await Promise.resolve();
      return decide(question);
    },
    ...setup.start,
  });
  const finished = (async (): Promise<string | null> => {
    try {
      for await (const event of run) {
        events.push(event);
      }
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  })();
  const sent = (): unknown[] =>
    readFileSync(record, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line));
  return { run, events, asked, finished, sent };
}

function ofType<T extends AgentEvent['type']>(
  events: readonly AgentEvent[],
  type: T,
): Extract<AgentEvent, { readonly type: T }>[] {
  return events.filter(
    (event): event is Extract<AgentEvent, { readonly type: T }> => event.type === type,
  );
}

async function turns(fake: Fake, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(ofType(fake.events, 'turn_result')).toHaveLength(count);
  }, WAIT);
}

describe('acpRuntime with the recorded Copilot session', () => {
  it(
    'rejects a shell call, then cancels a turn mid reply',
    async () => {
      const fake = startFake(COPILOT_ACP, {
        start: { permissionMode: 'agent' },
        spec: { modes: { agent: AGENT_MODE } },
      });
      expect(fake.run.sessionId).toBeNull();
      fake.run.send('Run the shell command `ls` and reply with how many files it listed.');
      await turns(fake, 1);
      expect(fake.run.sessionId).toBe(RECORDED_ID);
      expect(fake.events).toMatchObject([
        {
          type: 'init',
          model: 'gpt-5-mini',
          permissionMode: 'agent',
          version: '1.0.89',
          tools: [],
        },
        { type: 'context', usedTokens: 11_692, maxTokens: 128_000 },
        {
          type: 'message',
          model: 'gpt-5-mini',
          usage: null,
          blocks: [
            { type: 'thinking', text: "**Clarifying ls output**\n\nI'm analyzing how piping the" },
            {
              type: 'text',
              text: 'Running ls and counting its output lines to determine how many files are listed. Executing: ls -1 | wc -l',
            },
            {
              type: 'tool_use',
              id: 'call_kgV3yRzvlrfumod89OH34uO6',
              name: 'execute',
              input: { command: 'ls -1 | wc -l', description: 'Run ls and count listed entries' },
            },
          ],
        },
        {
          type: 'tool_result',
          toolUseId: 'call_kgV3yRzvlrfumod89OH34uO6',
          ok: false,
          text: 'The user rejected this tool call.',
        },
        {
          type: 'usage',
          usage: { input: 9453, output: 685, cacheRead: 1152, cacheCreation: 0, thinking: 576 },
        },
        { type: 'turn_result', ok: true, subtype: 'end_turn', costUsd: null },
      ]);
      const [message] = ofType(fake.events, 'message');
      expect(ofType(fake.events, 'usage')[0]?.messageId).toBe(message?.messageId);
      expect(fake.asked).toMatchObject([
        {
          name: 'execute',
          input: { command: 'ls -1 | wc -l', commands: ['ls -1 | wc -l'] },
          context: {
            toolUseId: 'call_kgV3yRzvlrfumod89OH34uO6',
            agentId: null,
            choices: ['allow', 'allow_session', 'deny', 'cancel'],
          },
        },
      ]);

      fake.run.send('Write a 300 word story about a lighthouse keeper.');
      await vi.waitFor(() => {
        expect(ofType(fake.events, 'context')).toHaveLength(2);
      }, WAIT);
      await fake.run.interrupt();
      await turns(fake, 2);
      const contexts = fake.events.flatMap((event, index) =>
        event.type === 'context' ? [index] : [],
      );
      const second = fake.events.slice(contexts[1] ?? 0);
      expect(second).toMatchObject([
        { type: 'context', usedTokens: 12_251 },
        {
          type: 'message',
          blocks: [{ type: 'thinking', text: '**Considering word count for story**\n\nThe user' }],
        },
        { type: 'turn_result', ok: false, subtype: 'interrupted', usage: null },
      ]);
      // The cancelled reply repeats the last total, so no usage is added.
      expect(ofType(fake.events, 'usage')).toHaveLength(1);

      fake.run.endInput();
      expect(await fake.finished).toBeNull();
      expect(fake.sent()).toMatchObject([
        { method: 'initialize', params: { protocolVersion: 1 } },
        { method: 'session/new', params: { mcpServers: [] } },
        { method: 'session/set_mode', params: { sessionId: RECORDED_ID, modeId: AGENT_MODE } },
        { method: 'session/prompt', params: { sessionId: RECORDED_ID } },
        { id: 0, result: { outcome: { outcome: 'selected', optionId: 'reject_once' } } },
        { method: 'session/prompt' },
        { method: 'session/cancel', params: { sessionId: RECORDED_ID } },
        { done: true, unmet: [] },
      ]);
    },
    TIMEOUT,
  );

  it(
    'loads the session in a new process without replaying its history',
    async () => {
      const fake = startFake(COPILOT_ACP, { proc: 'B', start: { resumeId: RECORDED_ID } });
      await vi.waitFor(() => {
        expect(fake.run.sessionId).toBe(RECORDED_ID);
      }, WAIT);
      fake.run.endInput();
      expect(await fake.finished).toBeNull();
      expect(fake.events.map((event) => event.type)).toStrictEqual(['init']);
      expect(fake.sent()).toMatchObject([
        { method: 'initialize' },
        { method: 'session/load', params: { sessionId: RECORDED_ID, mcpServers: [] } },
        { done: true, unmet: ['session/list'] },
      ]);
    },
    TIMEOUT,
  );

  it(
    'refuses a fork the agent does not offer',
    async () => {
      const fake = startFake(COPILOT_ACP, { start: { resumeId: RECORDED_ID, fork: true } });
      expect(await fake.finished).toMatch(
        /did not start a session: This agent cannot fork a session/u,
      );
      expect(fake.run.sessionId).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'shows the run in the Fleet and asks the inbox with the agent choices',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'overlord-acp-session-'));
      const bus = new EventBus();
      const inbox = new PermissionInbox();
      const asked: PermissionRequest[] = [];
      bus.on('permission.requested', (request) => {
        asked.push(request);
        // The session asks the inbox right after it publishes the request.
        setTimeout(() => {
          inbox.resolve(request.id, { behavior: 'deny', message: 'no', ruleId: null });
        }, 0);
      });
      const runtime = acpRuntime({
        command: process.execPath,
        args: [FAKE],
        env: { FAKE_ACP_SCRIPT: COPILOT_ACP, FAKE_ACP_RECORD: path.join(dir, 'record.jsonl') },
        modes: { agent: AGENT_MODE },
      });
      const session = AgentSession.start(
        { runtime, bus, broker: inbox },
        {
          agent: COPILOT,
          cwd: dir,
          title: 'ls',
          model: null,
          effort: null,
          permissionMode: 'agent',
          priced: false,
          env: {},
          extraArgs: {},
          maxBudgetUsd: null,
          executablePath: null,
        },
      );
      session.send('Run the shell command `ls` and reply with how many files it listed.');
      await vi.waitFor(() => {
        expect(session.summary()?.state).toBe('done');
      }, WAIT);
      expect(asked).toMatchObject([
        {
          sessionId: RECORDED_ID,
          agent: COPILOT,
          toolName: 'execute',
          source: 'runtime',
          choices: ['allow', 'allow_session', 'deny', 'cancel'],
        },
      ]);
      expect(session.summary()).toMatchObject({
        id: RECORDED_ID,
        agent: COPILOT,
        model: 'gpt-5-mini',
        permissionMode: 'agent',
        usage: { input: 9453, output: 685, cacheRead: 1152 },
      });
      session.stop();
      expect(await session.finished).toStrictEqual({ reason: 'stopped', error: null });
    },
    TIMEOUT,
  );
});

describe('acpRuntime with synthetic agents', () => {
  it(
    'holds a call until the permission request names its input, then allows it once',
    async () => {
      const fake = startFake(script('allow'), {
        decide: ({ input }) => ({ behavior: 'allow', updatedInput: input }),
      });
      fake.run.send('Fix calc.py');
      await turns(fake, 1);
      expect(fake.events).toMatchObject([
        { type: 'init', model: 'fake-model', permissionMode: null, version: '0.1.0' },
        {
          type: 'message',
          blocks: [
            { type: 'thinking', text: 'Let me think.' },
            { type: 'text', text: 'Let me edit it.' },
          ],
        },
        {
          type: 'message',
          blocks: [
            { type: 'tool_use', id: 'call-1', name: 'edit', input: { path: '/work/repo/calc.py' } },
          ],
        },
        { type: 'tool_result', toolUseId: 'call-1', ok: true, text: 'Edited 1 line' },
        { type: 'message', blocks: [{ type: 'text', text: 'Done.' }] },
        { type: 'usage', usage: { input: 60, output: 20, cacheRead: 40 } },
        { type: 'turn_result', ok: true, text: 'Done.' },
      ]);
      fake.run.send('Again');
      await turns(fake, 2);
      expect(ofType(fake.events, 'usage')[1]).toMatchObject({
        usage: { input: 50, output: 10, cacheRead: 0 },
      });
      expect(ofType(fake.events, 'turn_result')[1]).toMatchObject({
        costUsd: 0.25,
        text: 'Again.',
      });
      await expect(fake.run.contextUsage?.()).resolves.toStrictEqual({
        totalTokens: 5000,
        maxTokens: 100_000,
        fill: 0.05,
        categories: [],
      });
      await expect(fake.run.setPermissionMode?.('plan')).rejects.toThrow(
        'cannot change permission mode',
      );
      fake.run.endInput();
      expect(await fake.finished).toBeNull();
      expect(fake.sent()).toContainEqual({
        jsonrpc: '2.0',
        id: 0,
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      });
    },
    TIMEOUT,
  );

  it(
    'picks always allow for a session allow',
    async () => {
      const fake = startFake(script('allow'), {
        decide: ({ input }) => ({ behavior: 'allow', updatedInput: input, scope: 'session' }),
      });
      fake.run.send('Fix calc.py');
      await turns(fake, 1);
      fake.run.stop();
      expect(await fake.finished).toBeNull();
      expect(fake.sent()).toContainEqual({
        jsonrpc: '2.0',
        id: 0,
        result: { outcome: { outcome: 'selected', optionId: 'allow_always' } },
      });
    },
    TIMEOUT,
  );

  it(
    'cancels the turn when the inbox stops it',
    async () => {
      const fake = startFake(script('cancel'), {
        decide: () => ({ behavior: 'deny', message: 'Stop', interrupt: true }),
      });
      fake.run.send('Fix calc.py');
      await turns(fake, 1);
      expect(ofType(fake.events, 'turn_result')).toMatchObject([
        { ok: false, subtype: 'interrupted', usage: null },
      ]);
      expect(ofType(fake.events, 'tool_result')).toMatchObject([{ ok: false, text: 'Cancelled' }]);
      fake.run.endInput();
      expect(await fake.finished).toBeNull();
      expect(fake.sent()).toMatchObject([
        { method: 'initialize' },
        { method: 'session/new' },
        { method: 'session/prompt' },
        { method: 'session/cancel', params: { sessionId: 'fake-1' } },
        { id: 0, result: { outcome: { outcome: 'cancelled' } } },
        { done: true, unmet: [] },
      ]);
    },
    TIMEOUT,
  );

  it(
    'sends the profile settings, reports changes and switches model live',
    async () => {
      const fake = startFake(script('settings'), {
        start: { model: 'fake-big', effort: 'high', permissionMode: 'code' },
      });
      fake.run.send('Plan it');
      await turns(fake, 1);
      expect(fake.events).toMatchObject([
        { type: 'init', model: 'fake-big', permissionMode: 'code' },
        { type: 'mode_changed', permissionMode: 'ask' },
        { type: 'notice', text: 'Plan:\n- [x] Read the code\n- [~] Fix it' },
        { type: 'model_changed', model: 'fake-model' },
        { type: 'message', model: 'fake-model', blocks: [{ type: 'text', text: 'Planned.' }] },
        { type: 'turn_result', ok: true, usage: null },
      ]);
      await fake.run.setModel?.('fake-big');
      fake.run.endInput();
      expect(await fake.finished).toBeNull();
      expect(fake.sent()).toMatchObject([
        { method: 'initialize' },
        { method: 'session/new' },
        { method: 'session/set_config_option', params: { configId: 'model', value: 'fake-big' } },
        { method: 'session/set_config_option', params: { configId: 'effort', value: 'high' } },
        { method: 'session/set_mode', params: { modeId: 'code' } },
        { method: 'session/prompt' },
        { method: 'session/set_config_option', params: { configId: 'model', value: 'fake-big' } },
        { done: true, unmet: [] },
      ]);
    },
    TIMEOUT,
  );

  it(
    'turns settings the agent lacks into notices',
    async () => {
      const fake = startFake(script('cancel'), { start: { model: 'gpt-x', effort: 'max' } });
      await vi.waitFor(() => {
        expect(fake.events.length).toBeGreaterThan(0);
      }, WAIT);
      expect(fake.events).toMatchObject([
        { type: 'init', model: 'gpt-x' },
        {
          type: 'notice',
          text: 'This agent has no setting for model gpt-x, so it runs with its own',
        },
        {
          type: 'notice',
          text: 'This agent has no setting for effort max, so it runs with its own',
        },
      ]);
      await expect(fake.run.setModel?.('gpt-y')).rejects.toThrow('cannot change model');
      await expect(fake.run.contextUsage?.()).rejects.toThrow('not reported');
      fake.run.stop();
      expect(await fake.finished).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'resumes with session/resume and counts usage from the first total on',
    async () => {
      const fake = startFake(script('resume'), { start: { resumeId: 'old-1' } });
      fake.run.send('Hello again');
      fake.run.send('Once more');
      await turns(fake, 2);
      expect(fake.run.sessionId).toBe('old-1');
      expect(ofType(fake.events, 'turn_result')).toMatchObject([
        { usage: null, text: 'Back again.' },
        { usage: { input: 100, output: 10 }, text: 'And once more.' },
      ]);
      fake.run.endInput();
      expect(await fake.finished).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'fails with what the agent wrote when it dies',
    async () => {
      const fake = startFake(script('crash'), { exit: 1 });
      expect(await fake.finished).toMatch(/exited with code 1: Not logged in\. Run login first\./u);
    },
    TIMEOUT,
  );

  it(
    'fails when the agent cannot start',
    async () => {
      const fake = startFake(script('crash'), {
        start: { executablePath: path.join(FAKE_DIR, 'missing-agent') },
      });
      expect(await fake.finished).toMatch(/missing-agent .*ENOENT/u);
    },
    TIMEOUT,
  );
});

describe('flagArgs', () => {
  it('writes extra args as CLI flags', () => {
    expect(flagArgs({ verbose: null, model: 'x' })).toStrictEqual(['--verbose', '--model', 'x']);
  });
});
