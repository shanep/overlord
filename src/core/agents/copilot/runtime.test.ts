// Drives the Copilot runtime against test/fake-agents/copilot/fake-copilot.mjs,
// which records its args and replays the recorded Copilot ACP exchange.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { errorMessage } from '../../harness/events.js';
import type { AgentEvent } from '../shared/events.js';
import type { StartOptions, ToolPermissionResult } from '../shared/runtime.js';

import { copilotRuntime, copilotStart } from './runtime.js';

import { copilot } from './index.js';

const FAKE = fileURLToPath(
  new URL('../../../../test/fake-agents/copilot/fake-copilot.mjs', import.meta.url),
);
const SCRIPT = fileURLToPath(
  new URL('../../../../test/fixtures/copilot/1.0.89/acp/06-acp.jsonl', import.meta.url),
);
const RECORDED_ID = '314df6e1-afd1-4b9c-bdf3-7cf94861398e';
const AGENT_MODE = 'https://agentclientprotocol.com/protocol/session-modes#agent';
const TIMEOUT = 20_000;
const WAIT = { timeout: 10_000 };

function options(overrides: Partial<StartOptions> = {}): StartOptions {
  return {
    cwd: '/work/repo',
    sessionId: 'overlord-picked',
    resumeId: null,
    fork: false,
    env: {},
    model: null,
    effort: null,
    permissionMode: null,
    extraArgs: {},
    maxBudgetUsd: null,
    executablePath: null,
    noMcp: false,
    canUseTool: async (): Promise<ToolPermissionResult> => {
      await Promise.resolve();
      return { behavior: 'deny', message: 'Denied from Overlord' };
    },
    ...overrides,
  };
}

describe('copilotStart', () => {
  it('passes effort and allow all as launch flags and keeps the ACP modes', () => {
    expect(copilotStart(options({ effort: 'high', permissionMode: 'plan' }))).toMatchObject({
      extraArgs: { 'reasoning-effort': 'high' },
      effort: null,
      permissionMode: 'plan',
    });
    expect(
      copilotStart(options({ permissionMode: 'allow-all', extraArgs: { banner: null } })),
    ).toMatchObject({
      extraArgs: { banner: null, 'allow-all': null },
      effort: null,
      permissionMode: 'interactive',
    });
    expect(copilotStart(options())).toMatchObject({ extraArgs: {}, permissionMode: null });
  });

  it('is the runtime the adapter registers, with the inbox as its permission source', () => {
    expect(copilot.runtime).toBe(copilotRuntime);
    expect(copilotRuntime.permissionSource).toBe('runtime');
  });
});

describe('copilotRuntime', () => {
  it(
    'starts copilot --acp with the profile flags, sets its mode and answers its approval',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'overlord-copilot-'));
      // The runtime runs one binary with copilot's args, so a script stands in for it.
      const bin = path.join(dir, 'fake-copilot');
      writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
      chmodSync(bin, 0o755);
      const argsFile = path.join(dir, 'args.json');
      const record = path.join(dir, 'record.jsonl');
      const asked: string[] = [];
      const run = copilotRuntime.start(
        options({
          cwd: dir,
          executablePath: bin,
          env: {
            PATH: process.env['PATH'] ?? '',
            FAKE_COPILOT_ARGS: argsFile,
            FAKE_ACP_SCRIPT: SCRIPT,
            FAKE_ACP_RECORD: record,
          },
          effort: 'low',
          permissionMode: 'allow-all',
          canUseTool: async (name) => {
            asked.push(name);
            await Promise.resolve();
            return { behavior: 'deny', message: 'Denied from Overlord' };
          },
        }),
      );
      const events: AgentEvent[] = [];
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
      run.send('Run the shell command `ls` and reply with how many files it listed.');
      await vi.waitFor(() => {
        expect(events.some((event) => event.type === 'turn_result')).toBe(true);
      }, WAIT);
      run.stop();
      await finished;
      expect(run.sessionId).toBe(RECORDED_ID);
      expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toStrictEqual([
        '--acp',
        '--no-auto-update',
        '--reasoning-effort',
        'low',
        '--allow-all',
      ]);
      expect(events[0]).toMatchObject({ type: 'init', permissionMode: 'interactive' });
      expect(asked).toStrictEqual(['execute']);
      const sent = readFileSync(record, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line): unknown => JSON.parse(line));
      expect(sent).toContainEqual(
        expect.objectContaining({
          method: 'session/set_mode',
          params: { sessionId: RECORDED_ID, modeId: AGENT_MODE },
        }),
      );
    },
    TIMEOUT,
  );
});
