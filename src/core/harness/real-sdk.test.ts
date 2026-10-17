// End to end: the real Agent SDK query() spawns test/fake-claude/fake-claude.mjs
// in place of the Claude Code binary. Because the path ends in .mjs the SDK
// runs it with node, and the fake answers the stream-json control protocol and
// replays a scenario file. No real API or claude binary is ever involved.

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { flush, resolved } from '../../../test/fake-claude/fake-query.js';
import { CLAUDE_CODE } from '../../shared/agents.js';
import type { PermissionRequest, ToolCall } from '../../shared/model.js';
import { claudeRuntime, sdkPlanUsage } from '../agents/claude/runtime.js';
import { agents } from '../agents/index.js';
import { EventBus } from '../bus.js';

import type { SessionEvent, TurnResult } from './events.js';
import { PermissionInbox } from './inbox.js';
import { Launcher } from './launcher.js';
import { mergeEnv } from './options.js';
import { AgentSession, type SessionConfig } from './session.js';

const FAKE_DIR = fileURLToPath(new URL('../../../test/fake-claude/', import.meta.url));
const FAKE_CLAUDE = path.join(FAKE_DIR, 'fake-claude.mjs');
const TIMEOUT = 20_000;

const recordSchema = z.object({
  argv: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
});

function scenario(name: string): string {
  return path.join(FAKE_DIR, `${name}.json`);
}

async function nextResult(session: AgentSession): Promise<TurnResult> {
  return new Promise((resolve) => {
    const off = session.onEvent((event) => {
      if (event.name === 'turn.result') {
        off();
        resolve(event.payload);
      }
    });
  });
}

async function nextPermission(bus: EventBus): Promise<PermissionRequest> {
  return new Promise((resolve) => {
    const off = bus.on('permission.requested', (request) => {
      off();
      resolve(request);
    });
  });
}

/** The SDK passes most flags as --name=value and extraArgs as --name value. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index !== -1) {
    return argv[index + 1];
  }
  return argv.find((argument) => argument.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

interface Run {
  readonly session: AgentSession;
  readonly bus: EventBus;
  readonly inbox: PermissionInbox;
  readonly events: SessionEvent[];
  readonly tools: ToolCall[];
}

describe('real SDK against the fake Claude binary', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overlord-sdk-')));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function start(name: string, overrides: Partial<SessionConfig> = {}): Run {
    const bus = new EventBus();
    const inbox = new PermissionInbox({ bus });
    const tools: ToolCall[] = [];
    bus.on('tool.upserted', (call) => tools.push(call));
    const config: SessionConfig = {
      agent: CLAUDE_CODE,
      cwd: dir,
      title: name,
      model: 'claude-fake-1',
      effort: null,
      permissionMode: null,
      priced: true,
      env: mergeEnv(process.env, {
        FAKE_CLAUDE_SCENARIO: scenario(name),
        FAKE_CLAUDE_RECORD: path.join(dir, 'record.json'),
        FAKE_ECHO_PROFILE: 'from-profile',
      }),
      extraArgs: {},
      maxBudgetUsd: null,
      executablePath: FAKE_CLAUDE,
      ...overrides,
    };
    const session = AgentSession.start({ runtime: claudeRuntime(), bus, broker: inbox }, config);
    const events: SessionEvent[] = [];
    session.onEvent((event) => events.push(event));
    return { session, bus, inbox, events, tools };
  }

  it(
    'maps a full turn, passes options as CLI flags and applies live changes',
    async () => {
      const { session, events, tools } = start('success', {
        effort: 'high',
        permissionMode: 'acceptEdits',
        extraArgs: { 'fake-flag': 'x', 'fake-switch': null },
        maxBudgetUsd: 2,
      });
      const first = nextResult(session);
      session.send('hello');
      expect(await first).toStrictEqual({
        ok: true,
        subtype: 'success',
        text: 'The repo is Overlord.',
        costUsd: 0.0125,
        turns: 2,
        durationMs: 1500,
        usage: { input: 120, output: 40, cacheRead: 10, cacheCreation: 5, thinking: 0 },
      });

      const record = recordSchema.parse(
        JSON.parse(await readFile(path.join(dir, 'record.json'), 'utf8')),
      );
      expect(record.cwd).toBe(dir);
      expect(record.env).toStrictEqual({ FAKE_ECHO_PROFILE: 'from-profile' });
      expect(flagValue(record.argv, '--model')).toBe('claude-fake-1');
      expect(flagValue(record.argv, '--effort')).toBe('high');
      expect(flagValue(record.argv, '--permission-mode')).toBe('acceptEdits');
      expect(flagValue(record.argv, '--max-budget-usd')).toBe('2');
      expect(flagValue(record.argv, '--session-id')).toBe(session.id);
      expect(flagValue(record.argv, '--fake-flag')).toBe('x');
      expect(record.argv).toContain('--fake-switch');
      expect(flagValue(record.argv, '--output-format')).toBe('stream-json');
      expect(flagValue(record.argv, '--input-format')).toBe('stream-json');
      expect(flagValue(record.argv, '--permission-prompt-tool')).toBe('stdio');

      expect(session.info()).toStrictEqual({
        model: 'claude-fake-1',
        cwd: dir,
        tools: ['Bash', 'Read', 'Agent'],
        permissionMode: 'acceptEdits',
        mcpServers: [{ name: 'github', status: 'connected' }],
        version: '0.0.0-fake',
      });
      const feed = events.flatMap((event) =>
        event.name === 'feed.appended' ? event.payload.items : [],
      );
      expect(feed.map((item) => item.kind)).toStrictEqual([
        'user',
        'system',
        'thinking',
        'text',
        'tool_use',
        'tool_result',
        'system',
        'text',
      ]);
      expect(tools.at(-1)).toMatchObject({
        id: 'toolu_success_1',
        name: 'Read',
        ok: true,
        resultPreview: '# Overlord',
      });
      expect(session.agents().find((agent) => agent.id === 'task_1')).toMatchObject({
        agentType: 'Explore',
        parentToolUseId: 'toolu_agent_1',
        state: 'done',
      });
      expect(events.some((event) => event.name === 'compaction.recorded')).toBe(true);
      const limits = events.flatMap((event) =>
        event.name === 'rateLimits.updated' ? [event.payload] : [],
      );
      expect(limits).toMatchObject([
        { fiveHourPct: 25, sevenDayPct: null, resetsAt: 1_800_000_000_000 },
      ]);
      expect(session.summary()).toMatchObject({ state: 'done', costUsd: 0.0125, agentCount: 1 });

      await session.setModel('claude-fake-2');
      await session.setPermissionMode('plan');
      const usage = await session.contextUsage();
      expect(usage.totalTokens).toBe(13_000);
      expect(usage.fill).toBeCloseTo(0.065, 10);
      expect(usage.categories[0]).toStrictEqual({
        name: 'System prompt',
        tokens: 3000,
        kind: 'used',
      });

      const second = nextResult(session);
      session.send('again');
      expect(await second).toMatchObject({ ok: true, text: 'Second answer.', costUsd: 0.02 });
      expect(session.info()).toMatchObject({ model: 'claude-fake-2', permissionMode: 'plan' });

      session.close();
      expect(await session.finished).toStrictEqual({ reason: 'completed', error: null });
      expect(session.summary()?.state).toBe('done');
    },
    TIMEOUT,
  );

  it(
    'routes can_use_tool through the inbox, then interrupts the turn',
    async () => {
      const { session, bus, inbox, tools } = start('permission');
      const asked = nextPermission(bus);
      const result = nextResult(session);
      session.send('clean up');
      const request = await asked;
      expect(request).toMatchObject({
        sessionId: session.id,
        agentId: session.id,
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
        source: 'sdk',
      });
      expect(inbox.list()).toStrictEqual([request]);
      expect(session.summary()?.state).toBe('waiting');
      inbox.resolve(request.id, { behavior: 'allow', ruleId: null });
      while (tools.at(-1)?.ok !== true) {
        await flush();
      }
      expect(tools.at(-1)).toMatchObject({
        id: 'toolu_perm_1',
        ok: true,
        resultPreview: 'removed',
      });
      expect(session.summary()?.state).toBe('running');

      await session.interrupt();
      expect(await result).toMatchObject({
        ok: false,
        subtype: 'error_during_execution',
        text: 'interrupted',
      });
      session.close();
      expect(await session.finished).toStrictEqual({ reason: 'completed', error: null });
      expect(session.summary()?.state).toBe('failed');
    },
    TIMEOUT,
  );

  it(
    'feeds a deny back to the CLI and stops the process',
    async () => {
      const { session, bus, inbox, tools } = start('permission');
      const asked = nextPermission(bus);
      session.send('clean up');
      const request = await asked;
      inbox.resolve(request.id, { behavior: 'deny', message: 'not on my watch', ruleId: null });
      while (tools.at(-1)?.ok !== false) {
        await flush();
      }
      expect(tools.at(-1)).toMatchObject({ ok: false, resultPreview: 'not on my watch' });
      session.stop();
      expect(await session.finished).toStrictEqual({ reason: 'stopped', error: null });
      expect(session.summary()?.state).toBe('done');
    },
    TIMEOUT,
  );

  it(
    'maps an error result',
    async () => {
      const { session } = start('error');
      const result = nextResult(session);
      session.send('break');
      expect(await result).toMatchObject({
        ok: false,
        subtype: 'error_during_execution',
        text: 'boom',
        costUsd: 0.003,
      });
      session.close();
      await session.finished;
      expect(session.summary()?.state).toBe('failed');
    },
    TIMEOUT,
  );

  it(
    'runs a launcher batch end to end',
    async () => {
      const launcher = new Launcher(
        {
          agents,
          bus: new EventBus(),
          broker: new PermissionInbox(),
          baseEnv: async (): Promise<Readonly<Record<string, string | undefined>>> =>
            resolved({ ...process.env, FAKE_CLAUDE_SCENARIO: scenario('success') }),
          executablePath: (): string => FAKE_CLAUDE,
        },
        1,
      );
      const spec = { cwd: dir, profileId: null, worktree: false, maxBudgetUsd: null };
      launcher.launch(
        [
          { ...spec, prompt: 'one', label: 'one' },
          { ...spec, prompt: 'two', label: 'two' },
        ],
        [],
      );
      await launcher.idle();
      expect(
        launcher.runs().map((run) => [run.state, run.costUsd, run.turns, run.result]),
      ).toStrictEqual([
        ['done', 0.0125, 2, 'The repo is Overlord.'],
        ['done', 0.0125, 2, 'The repo is Overlord.'],
      ]);
      expect(launcher.spendUsd()).toBeCloseTo(0.025, 10);
    },
    TIMEOUT,
  );
  it(
    'reads plan usage from a CLI started with no prompt, then closes it',
    async () => {
      const reply = await sdkPlanUsage({
        cwd: dir,
        env: mergeEnv(process.env, {
          FAKE_CLAUDE_SCENARIO: scenario('success'),
          FAKE_CLAUDE_RECORD: path.join(dir, 'record.json'),
        }),
        executablePath: FAKE_CLAUDE,
      });
      expect(reply).toStrictEqual({
        rate_limits_available: false,
        rate_limits: null,
        skip_behaviors: true,
      });
      const recorded = recordSchema.parse(
        JSON.parse(await readFile(path.join(dir, 'record.json'), 'utf8')),
      );
      expect(recorded.cwd).toBe(dir);
    },
    TIMEOUT,
  );
});
