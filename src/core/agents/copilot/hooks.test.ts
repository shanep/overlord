import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { HookEventKind, NormalizedHookEvent } from '../../hooks/normalized.js';
import { editedFiles } from '../../hooks/normalized.js';
import { makeTemporaryDirectory, removeDir } from '../../transcripts/test-helpers/fixtures.js';
import type { AgentDirs } from '../types.js';

import {
  answerCopilotHook,
  COPILOT_HOOK_EVENTS,
  copilotDirs,
  createCopilotHooks,
  hooksFile,
  NoteCarry,
  normalizeCopilotHook,
} from './hooks.js';

const FIXTURE = fileURLToPath(
  new URL('../../../../test/fixtures/copilot/1.0.89/hooks/hooks.jsonl', import.meta.url),
);
const EDIT_EVENTS = fileURLToPath(
  new URL(
    '../../../../test/fixtures/copilot/1.0.89/session-state/11111111-1111-4111-8111-000000000003/events.jsonl',
    import.meta.url,
  ),
);
const COMMAND = 'node "/ext/dist/overlord-hook.cjs"';

interface Recorded {
  readonly event: string;
  readonly payload: unknown;
}

async function recorded(): Promise<readonly Recorded[]> {
  const text = await readFile(FIXTURE, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line): Recorded => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null) {
        throw new TypeError('not a fixture line');
      }
      return { event: String(Reflect.get(value, 'event')), payload: Reflect.get(value, 'payload') };
    });
}

function normalized(line: Recorded): NormalizedHookEvent {
  const result = normalizeCopilotHook({ payload: line.payload, name: line.event });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.event;
}

function event(kind: HookEventKind, native: string): NormalizedHookEvent {
  const base = {
    agent: 'copilot',
    native,
    sessionId: 's',
    subagentId: null,
    cwd: '/w',
    transcriptPath: null,
    timestamp: 1,
  };
  if (kind === 'pre-tool-use') {
    return { ...base, kind, tool: { name: 'edit', input: { path: '/w/a.ts' }, useId: null } };
  }
  if (kind === 'post-tool-use') {
    return {
      ...base,
      kind,
      tool: { name: 'bash', input: { command: 'ls' }, useId: null },
      response: null,
    };
  }
  if (kind === 'permission-request') {
    return { ...base, kind, tool: { name: 'bash', input: { command: 'ls' }, useId: null } };
  }
  if (kind === 'session-start') {
    return { ...base, kind, source: 'new', model: null, title: null };
  }
  return { ...base, kind: 'prompt-submit', prompt: 'go', title: null };
}

describe('normalizeCopilotHook', () => {
  it('reads every recorded payload', async () => {
    const lines = await recorded();
    const events = lines.map((line) => normalized(line));
    expect(events.map((item) => [item.native, item.kind])).toStrictEqual([
      ['userPromptSubmitted', 'prompt-submit'],
      ['sessionStart', 'session-start'],
      ['preToolUse', 'pre-tool-use'],
      ['permissionRequest', 'permission-request'],
      ['postToolUse', 'post-tool-use'],
      ['agentStop', 'stop'],
      ['sessionEnd', 'stop'],
      ['userPromptSubmitted', 'prompt-submit'],
      ['sessionStart', 'session-start'],
      ['preToolUse', 'pre-tool-use'],
      ['permissionRequest', 'permission-request'],
      ['notification', 'notification'],
      ['sessionEnd', 'stop'],
      ['userPromptSubmitted', 'prompt-submit'],
      ['sessionEnd', 'stop'],
    ]);
    expect(events.every((item) => item.agent === 'copilot' && item.cwd === '/work/repo')).toBe(
      true,
    );
  });

  it('keeps the fields the coordinator and the inbox read', async () => {
    const lines = await recorded();
    const [prompt, start, pre, permission, post, stop] = lines.map((line) => normalized(line));
    expect(prompt).toMatchObject({
      sessionId: '11111111-1111-4111-8111-000000000005',
      timestamp: 1_792_210_179_302,
      prompt: 'Run the shell command `ls` and reply with how many files it listed.',
      subagentId: null,
    });
    expect(start).toMatchObject({ source: 'new', model: null, title: null });
    expect(pre).toMatchObject({
      tool: { name: 'bash', input: { command: 'ls; ls | wc -l' }, useId: null },
    });
    expect(permission).toMatchObject({
      tool: { name: 'bash', input: { command: 'ls; ls | wc -l' }, useId: null },
    });
    expect(post).toMatchObject({ response: { resultType: 'success' } });
    expect(stop).toMatchObject({
      transcriptPath:
        '/home/user/.copilot/session-state/11111111-1111-4111-8111-000000000005/events.jsonl',
      lastMessage: null,
    });
  });

  it('ends the session only for a reason other than complete', () => {
    const result = normalizeCopilotHook({
      payload: { sessionId: 's', reason: 'user_exit' },
      name: 'sessionEnd',
    });
    expect(result).toMatchObject({ ok: true, event: { kind: 'session-end', reason: 'user_exit' } });
  });

  it('takes the name from hookName when the relay gave none', async () => {
    const lines = await recorded();
    const permission = lines.find((line) => line.event === 'permissionRequest');
    expect(normalizeCopilotHook({ payload: permission?.payload, name: null })).toMatchObject({
      ok: true,
      event: { kind: 'permission-request' },
    });
  });

  it('reads an unknown event or an unexpected shape as other, and needs a session id', () => {
    expect(
      normalizeCopilotHook({ payload: { sessionId: 's' }, name: 'errorOccurred' }),
    ).toMatchObject({ ok: true, event: { kind: 'other', native: 'errorOccurred' } });
    expect(
      normalizeCopilotHook({ payload: { sessionId: 's', prompt: 3 }, name: 'userPromptSubmitted' }),
    ).toMatchObject({ ok: true, event: { kind: 'other' } });
    expect(normalizeCopilotHook({ payload: { cwd: '/w' }, name: 'sessionStart' }).ok).toBe(false);
    expect(normalizeCopilotHook({ payload: null, name: 'sessionStart' }).ok).toBe(false);
  });
});

describe('answerCopilotHook', () => {
  it('writes permission decisions in the shape permissionRequest reads', () => {
    const carry = new NoteCarry();
    const asked = event('permission-request', 'permissionRequest');
    expect(
      answerCopilotHook(carry, asked, { decision: { behavior: 'allow', ruleId: 'r' } }),
    ).toStrictEqual({ behavior: 'allow' });
    expect(
      answerCopilotHook(carry, asked, {
        decision: { behavior: 'deny', ruleId: null, message: 'no', interrupt: true },
      }),
    ).toStrictEqual({ behavior: 'deny', message: 'no', interrupt: true });
    expect(
      answerCopilotHook(carry, asked, {
        decision: { behavior: 'deny', ruleId: null, message: 'no' },
      }),
    ).toStrictEqual({ behavior: 'deny', message: 'no' });
  });

  it('blocks a preToolUse with a deny', () => {
    expect(
      answerCopilotHook(new NoteCarry(), event('pre-tool-use', 'preToolUse'), {
        block: 'another session edits a.ts',
      }),
    ).toStrictEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: 'another session edits a.ts',
    });
  });

  it('holds a prompt note until the next event that carries context', () => {
    const carry = new NoteCarry();
    const prompt = event('prompt-submit', 'userPromptSubmitted');
    expect(answerCopilotHook(carry, prompt, { context: 'peers', notice: 'seen' })).toStrictEqual(
      {},
    );
    expect(answerCopilotHook(carry, prompt, { context: 'peers' })).toStrictEqual({});
    const start = event('session-start', 'sessionStart');
    expect(answerCopilotHook(carry, start, { context: 'briefing' })).toStrictEqual({
      additionalContext: 'peers\n\nbriefing',
    });
    expect(answerCopilotHook(carry, start, {})).toStrictEqual({});
  });

  it('sends held notes on a postToolUse with no answer of its own', () => {
    const carry = new NoteCarry();
    answerCopilotHook(carry, event('prompt-submit', 'userPromptSubmitted'), { context: 'landed' });
    expect(answerCopilotHook(carry, event('post-tool-use', 'postToolUse'), {})).toStrictEqual({
      additionalContext: 'landed',
    });
    expect(answerCopilotHook(carry, event('post-tool-use', 'postToolUse'), {})).toStrictEqual({});
  });

  it('forgets the oldest sessions past its cap', () => {
    const carry = new NoteCarry();
    for (let index = 0; index <= 200; index += 1) {
      carry.add(`s${String(index)}`, 'note');
    }
    expect(carry.take('s0')).toStrictEqual([]);
    expect(carry.take('s200')).toStrictEqual(['note']);
  });
});

describe('copilot edit tools', () => {
  it('finds the path of the recorded edit and not of a view', async () => {
    const hooks = createCopilotHooks();
    const text = await readFile(EDIT_EVENTS, 'utf8');
    const calls = text
      .split('\n')
      .filter((line) => line.includes('"tool.execution_start"'))
      .map((line): unknown => JSON.parse(line))
      .map((line) => {
        const data: unknown =
          typeof line === 'object' && line !== null ? Reflect.get(line, 'data') : null;
        if (typeof data !== 'object' || data === null) {
          return null;
        }
        const input: unknown = Reflect.get(data, 'arguments');
        return { name: String(Reflect.get(data, 'toolName')), input };
      })
      .filter((call) => call !== null);
    const files = calls.map((call) => editedFiles(hooks.editTools, { ...call, useId: null }));
    expect(calls.map((call) => call.name)).toStrictEqual(['view', 'edit']);
    expect(files[0]).toStrictEqual([]);
    expect(files[1]).toHaveLength(1);
    expect(files[1]?.[0]).toMatch(/calc\.py$/u);
    const patch = '*** Begin Patch\n*** Update File: /w/a.ts\n@@\n-a\n+b\n*** End Patch\n';
    expect(
      editedFiles(hooks.editTools, { name: 'apply_patch', input: patch, useId: null }),
    ).toStrictEqual(['/w/a.ts']);
    expect(
      editedFiles(hooks.editTools, { name: 'create', input: { path: '/w/new.ts' }, useId: null }),
    ).toStrictEqual(['/w/new.ts']);
  });
});

describe('copilot hooks install', () => {
  let dir: string;
  let dirs: AgentDirs;

  beforeEach(async () => {
    dir = await makeTemporaryDirectory();
    dirs = copilotDirs(dir, { COPILOT_HOME: path.join(dir, 'copilot-home') });
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it('puts its folder in COPILOT_HOME, else ~/.copilot', () => {
    expect(hooksFile(dirs)).toBe(path.join(dir, 'copilot-home', 'hooks', 'overlord.json'));
    expect(copilotDirs('/home/user', {}).configDir).toBe(path.join('/home/user', '.copilot'));
  });

  it('writes one file with every event, and leaves the user files alone', async () => {
    const hooks = createCopilotHooks();
    const folder = path.dirname(hooksFile(dirs));
    await mkdir(folder, { recursive: true });
    const mine = path.join(folder, 'mine.json');
    await writeFile(mine, '{"version":1,"hooks":{}}\n');
    expect(await hooks.installed(dirs)).toBe(false);
    await expect(hooks.install(dirs, COMMAND)).resolves.toStrictEqual({ changed: true });
    await expect(hooks.install(dirs, COMMAND)).resolves.toStrictEqual({ changed: false });
    expect(await hooks.installed(dirs)).toBe(true);
    const written: unknown = JSON.parse(await readFile(hooksFile(dirs), 'utf8'));
    expect(written).toMatchObject({
      version: 1,
      hooks: {
        sessionStart: [
          {
            type: 'command',
            bash: `${COMMAND} --agent copilot --event sessionStart`,
            powershell: `${COMMAND} --agent copilot --event sessionStart`,
            timeoutSec: 5,
          },
        ],
      },
    });
    const events = z.looseObject({ hooks: z.record(z.string(), z.unknown()) }).parse(written);
    expect(Object.keys(events.hooks)).toStrictEqual(COPILOT_HOOK_EVENTS);
    await expect(hooks.uninstall(dirs)).resolves.toStrictEqual({ changed: true });
    await expect(hooks.uninstall(dirs)).resolves.toStrictEqual({ changed: false });
    expect(await readdir(folder)).toStrictEqual(['mine.json']);
    expect(await readFile(mine, 'utf8')).toBe('{"version":1,"hooks":{}}\n');
  });

  it('keeps a file of its name that has no Overlord command', async () => {
    const hooks = createCopilotHooks();
    await mkdir(path.dirname(hooksFile(dirs)), { recursive: true });
    await writeFile(hooksFile(dirs), '{"version":1,"hooks":{"sessionStart":[{"bash":"echo"}]}}');
    expect(await hooks.installed(dirs)).toBe(false);
    await expect(hooks.uninstall(dirs)).resolves.toStrictEqual({ changed: false });
    expect(await readFile(hooksFile(dirs), 'utf8')).toContain('echo');
  });

  it('refuses a command without the marker', async () => {
    await expect(createCopilotHooks().install(dirs, 'node hook.js')).rejects.toThrow(
      'overlord-hook',
    );
  });
});
