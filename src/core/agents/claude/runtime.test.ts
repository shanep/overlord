import { describe, expect, it } from 'vitest';

import { fakeRuntime, flush, resolved } from '../../../../test/fake-claude/fake-query.js';
import type { StartOptions, ToolPermissionContext } from '../shared/runtime.js';

import {
  claudeEvents,
  sdkPermissionResult,
  toEffortLevel,
  toPermissionMode,
  toPlanUsageOptions,
  toSdkOptions,
  toSdkPermissionMode,
  type QueryOptions,
} from './runtime.js';

function options(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return {
    cwd: '/repo',
    sessionId: 'sid',
    resume: null,
    forkSession: false,
    env: { PATH: '/bin' },
    abortController: new AbortController(),
    canUseTool: async (_toolName, input) => resolved({ behavior: 'allow', updatedInput: input }),
    model: null,
    effort: null,
    permissionMode: null,
    extraArgs: {},
    maxBudgetUsd: null,
    executablePath: null,
    noMcp: false,
    ...overrides,
  };
}

describe('toSdkOptions', () => {
  it('leaves unset options out', () => {
    const base = options();
    const sdk = toSdkOptions(base);
    expect(Object.keys(sdk).toSorted((left, right) => left.localeCompare(right))).toStrictEqual(
      [
        'abortController',
        'canUseTool',
        'cwd',
        'env',
        'extraArgs',
        'sessionId',
        'settingSources',
        'systemPrompt',
      ].toSorted((left, right) => left.localeCompare(right)),
    );
    expect(sdk.cwd).toBe('/repo');
    expect(sdk.sessionId).toBe('sid');
    expect(sdk.env).toStrictEqual({ PATH: '/bin' });
    expect(sdk.abortController).toBe(base.abortController);
    expect(sdk.extraArgs).toStrictEqual({});
  });

  it('passes every set option through', () => {
    const sdk = toSdkOptions(
      options({
        model: 'opus',
        effort: 'high',
        permissionMode: 'plan',
        extraArgs: { debug: null },
        maxBudgetUsd: 3,
        executablePath: '/bin/fake.mjs',
      }),
    );
    expect(sdk.model).toBe('opus');
    expect(sdk.effort).toBe('high');
    expect(sdk.permissionMode).toBe('plan');
    expect(sdk.allowDangerouslySkipPermissions).toBeUndefined();
    expect(sdk.extraArgs).toStrictEqual({ debug: null });
    expect(sdk.maxBudgetUsd).toBe(3);
    expect(sdk.pathToClaudeCodeExecutable).toBe('/bin/fake.mjs');
  });

  it('starts runs with the same prompt and settings as the CLI', () => {
    const sdk = toSdkOptions(options());
    expect(sdk.systemPrompt).toStrictEqual({ type: 'preset', preset: 'claude_code' });
    expect(sdk.settingSources).toStrictEqual(['user', 'project', 'local']);
  });

  it('runs a session without MCP servers, keeping the prompt and tools', () => {
    const sdk = toSdkOptions(options({ noMcp: true }));
    expect(sdk.systemPrompt).toStrictEqual({ type: 'preset', preset: 'claude_code' });
    expect(sdk.tools).toBeUndefined();
    expect(sdk.strictMcpConfig).toBe(true);
    expect(sdk.mcpServers).toStrictEqual({});
    expect(sdk.settingSources).toStrictEqual(['user', 'project', 'local']);
  });

  it('leaves tools and MCP alone otherwise', () => {
    const sdk = toSdkOptions(options());
    expect(sdk.tools).toBeUndefined();
    expect(sdk.strictMcpConfig).toBeUndefined();
    expect(sdk.mcpServers).toBeUndefined();
  });

  it('allows bypassPermissions explicitly', () => {
    const sdk = toSdkOptions(options({ permissionMode: 'bypassPermissions' }));
    expect(sdk.allowDangerouslySkipPermissions).toBe(true);
  });

  it('adapts the permission callback', async () => {
    const seen: ToolPermissionContext[] = [];
    const sdk = toSdkOptions(
      options({
        canUseTool: async (toolName, input, context) => {
          seen.push(context);
          return resolved({
            behavior: 'deny',
            message: `no ${toolName} ${String(input['x'])}`,
          });
        },
      }),
    );
    const signal = new AbortController().signal;
    const result = await sdk.canUseTool?.(
      'Bash',
      { x: 1 },
      { signal, toolUseID: 'tu1', requestId: 'r1' },
    );
    expect(result).toStrictEqual({ behavior: 'deny', message: 'no Bash 1' });
    await sdk.canUseTool?.(
      'Bash',
      {},
      { signal, toolUseID: 'tu2', agentID: 'agent-7', requestId: 'r2' },
    );
    expect(seen).toStrictEqual([
      { signal, toolUseId: 'tu1', agentId: null },
      { signal, toolUseId: 'tu2', agentId: 'agent-7' },
    ]);
  });
});

describe('sdkPermissionResult', () => {
  it('allows once even when asked for the session, and keeps an interrupt', () => {
    expect(
      sdkPermissionResult({ behavior: 'allow', updatedInput: { a: 1 }, scope: 'session' }),
    ).toStrictEqual({ behavior: 'allow', updatedInput: { a: 1 } });
    expect(sdkPermissionResult({ behavior: 'deny', message: 'no', interrupt: true })).toStrictEqual(
      { behavior: 'deny', message: 'no', interrupt: true },
    );
    expect(sdkPermissionResult({ behavior: 'deny', message: 'no' })).toStrictEqual({
      behavior: 'deny',
      message: 'no',
    });
  });
});

describe('toPlanUsageOptions', () => {
  it('loads no settings, writes no session and passes a binary only when set', () => {
    const env = { PATH: '/bin' };
    const bundled = toPlanUsageOptions({ cwd: '/home', env, executablePath: null });
    expect(bundled).toStrictEqual({
      cwd: '/home',
      env: { PATH: '/bin' },
      settingSources: [],
      persistSession: false,
    });
    expect(bundled.env).not.toBe(env);
    expect(toPlanUsageOptions({ cwd: '/home', env, executablePath: '/bin/claude' })).toMatchObject({
      pathToClaudeCodeExecutable: '/bin/claude',
    });
  });
});

describe('toSdkOptions resume', () => {
  it('resumes under the old id, or forks under the new one', () => {
    const resumed = toSdkOptions(options({ sessionId: null, resume: 'old' }));
    expect(resumed.resume).toBe('old');
    expect(resumed.sessionId).toBeUndefined();
    expect(resumed.forkSession).toBeUndefined();
    const forked = toSdkOptions(options({ resume: 'old', forkSession: true }));
    expect(forked).toMatchObject({ resume: 'old', sessionId: 'sid', forkSession: true });
  });
});

describe('toEffortLevel', () => {
  it('accepts every SDK level and null', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(toEffortLevel(level)).toBe(level);
    }
    expect(toEffortLevel(null)).toBeNull();
  });

  it('rejects unknown levels', () => {
    expect(() => toEffortLevel('extreme')).toThrow('Unknown effort level "extreme"');
  });
});

describe('toSdkPermissionMode', () => {
  it('maps manual to default and passes the rest through', () => {
    expect(toSdkPermissionMode('manual')).toBe('default');
    expect(toSdkPermissionMode('plan')).toBe('plan');
    expect(toSdkPermissionMode('bypassPermissions')).toBe('bypassPermissions');
  });
});

describe('toPermissionMode', () => {
  it('accepts every Claude mode and null', () => {
    expect(toPermissionMode(null)).toBeNull();
    expect(toPermissionMode('plan')).toBe('plan');
    expect(toPermissionMode('manual')).toBe('manual');
  });

  it('rejects modes Claude does not have', () => {
    expect(() => toPermissionMode('yolo')).toThrow('Unknown permission mode "yolo"');
  });
});

describe('claudeEvents', () => {
  it('ignores messages it does not read', () => {
    expect(claudeEvents({ type: 'stream_event' })).toStrictEqual([]);
    expect(claudeEvents('nope')).toStrictEqual([]);
  });

  it('drops rate limit events with no window type', () => {
    expect(
      claudeEvents({ type: 'rate_limit_event', rate_limit_info: { utilization: 0.5 } }),
    ).toStrictEqual([]);
  });

  it('reports unknown permission modes as null', () => {
    expect(
      claudeEvents({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        model: 'm',
        cwd: '/',
        tools: [],
        permissionMode: 'yolo',
        mcp_servers: [],
      }),
    ).toMatchObject([{ type: 'init', permissionMode: null, version: null }]);
  });
});

function start(overrides: Partial<StartOptions> = {}): StartOptions {
  return {
    cwd: '/repo',
    sessionId: 'new-id',
    resumeId: null,
    fork: false,
    env: {},
    model: null,
    effort: 'low',
    permissionMode: 'manual',
    extraArgs: {},
    maxBudgetUsd: null,
    executablePath: null,
    noMcp: false,
    canUseTool: async (_toolName, input) => resolved({ behavior: 'allow', updatedInput: input }),
    ...overrides,
  };
}

describe('claudeRuntime', () => {
  it('starts a query with the session id and Claude modes', () => {
    const fakes = fakeRuntime();
    const run = fakes.runtime.start(start());
    expect(fakes.runtime.permissionSource).toBe('sdk');
    expect(run.sessionId).toBe('new-id');
    expect(fakes.queries[0]?.options).toMatchObject({
      sessionId: 'new-id',
      resume: null,
      forkSession: false,
      effort: 'low',
      permissionMode: 'default',
    });
  });

  it('keeps the old id on resume and takes the new one on a fork', () => {
    const fakes = fakeRuntime();
    expect(fakes.runtime.start(start({ resumeId: 'old' })).sessionId).toBe('old');
    expect(fakes.queries[0]?.options).toMatchObject({ sessionId: null, resume: 'old' });
    expect(fakes.runtime.start(start({ resumeId: 'old', fork: true })).sessionId).toBe('new-id');
    expect(fakes.queries[1]?.options).toMatchObject({
      sessionId: 'new-id',
      resume: 'old',
      forkSession: true,
    });
  });

  it('refuses modes and effort levels Claude does not have', () => {
    const fakes = fakeRuntime();
    expect(() => fakes.runtime.start(start({ effort: 'extreme' }))).toThrow('Unknown effort level');
    expect(() => fakes.runtime.start(start({ permissionMode: 'yolo' }))).toThrow(
      'Unknown permission mode',
    );
    fakes.runtime.start(start({ permissionMode: null }));
    expect(fakes.queries[0]?.options.permissionMode).toBeNull();
  });

  it('translates the stream and forwards prompts and control calls', async () => {
    const fakes = fakeRuntime();
    const run = fakes.runtime.start(start());
    const [query] = fakes.queries;
    if (query === undefined) {
      throw new Error('no query was created');
    }
    run.send('hello');
    await run.setModel?.('opus');
    await run.setPermissionMode?.('plan');
    await expect(run.setPermissionMode?.('yolo')).rejects.toThrow('Unknown permission mode');
    await run.interrupt();
    expect(await run.contextUsage?.()).toMatchObject({ fill: 0.5 });
    await flush();
    expect(query.prompts).toStrictEqual(['hello']);
    expect(query.models).toStrictEqual(['opus']);
    expect(query.modes).toStrictEqual(['plan']);
    expect(query.interrupts).toBe(1);
    query.emit({ type: 'user', message: { content: 'plain' } });
    query.emit({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    });
    run.endInput();
    query.end();
    const events: unknown[] = [];
    for await (const event of run) {
      events.push(event);
    }
    expect(events).toStrictEqual([
      { type: 'tool_result', toolUseId: 't1', ok: true, text: 'done' },
    ]);
    await flush();
    expect(query.inputEnded).toBe(true);
  });

  it('aborts the query on stop', async () => {
    const fakes = fakeRuntime();
    const run = fakes.runtime.start(start());
    run.stop();
    const events: unknown[] = [];
    await expect(
      (async (): Promise<void> => {
        for await (const event of run) {
          events.push(event);
        }
      })(),
    ).rejects.toThrow('aborted');
    expect(events).toStrictEqual([]);
  });
});
