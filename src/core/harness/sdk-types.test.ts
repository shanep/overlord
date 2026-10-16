import { describe, expect, it } from 'vitest';

import { resolved } from '../../../test/fake-claude/fake-query.js';

import { toSdkOptions, type QueryOptions, type ToolPermissionContext } from './sdk-types.js';

function options(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return {
    cwd: '/repo',
    sessionId: 'sid',
    env: { PATH: '/bin' },
    abortController: new AbortController(),
    canUseTool: async (_toolName, input) => resolved({ behavior: 'allow', updatedInput: input }),
    model: null,
    effort: null,
    permissionMode: null,
    extraArgs: {},
    maxBudgetUsd: null,
    executablePath: null,
    ...overrides,
  };
}

describe('toSdkOptions', () => {
  it('leaves unset options out', () => {
    const base = options();
    const sdk = toSdkOptions(base);
    expect(Object.keys(sdk).toSorted((left, right) => left.localeCompare(right))).toStrictEqual(
      ['abortController', 'canUseTool', 'cwd', 'env', 'extraArgs', 'sessionId'].toSorted(
        (left, right) => left.localeCompare(right),
      ),
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
