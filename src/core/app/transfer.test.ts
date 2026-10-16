import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateSkillFile } from '../authoring/validate.js';
import type { LiveProcess } from '../surfaces/live.js';

import { defaultDelay } from './app-deps.js';
import { makeApp, makeEnv, writeText } from './test-helpers/fixtures.js';
import {
  clearOtherCopy,
  EXIT_WAIT_MS,
  EXTENSION_ID,
  parseTransferUri,
  SKILL_NAME,
  TRANSFER_PATH,
  transferSkillPath,
  transferSkillText,
} from './transfer.js';

function live(overrides: Partial<LiveProcess>): LiveProcess {
  return {
    sessionId: 's1',
    pid: 42,
    alive: true,
    state: null,
    status: null,
    kind: null,
    name: null,
    cwd: null,
    entrypoint: null,
    version: null,
    startedAt: null,
    updatedAt: null,
    agentId: null,
    messagingSocketPath: null,
    sources: ['registry'],
    ...overrides,
  };
}

describe('parseTransferUri', () => {
  it('reads the session id from a continue link', () => {
    expect(TRANSFER_PATH).toBe('/continue');
    expect(parseTransferUri('/continue', 'session=5b812c2d-9caa_48b5')).toBe('5b812c2d-9caa_48b5');
  });

  it('rejects other paths, missing ids and ids with odd characters', () => {
    expect(parseTransferUri('/other', 'session=abc')).toBeNull();
    expect(parseTransferUri('/continue', '')).toBeNull();
    expect(parseTransferUri('/continue', 'session=')).toBeNull();
    expect(parseTransferUri('/continue', 'session=a%20b')).toBeNull();
    expect(parseTransferUri('/continue', 'session=..%2Fetc')).toBeNull();
    expect(parseTransferUri('/continue', `session=${'a'.repeat(129)}`)).toBeNull();
    expect(parseTransferUri('/continue', `session=${'a'.repeat(128)}`)).toBe('a'.repeat(128));
  });
});

describe('transferSkillText', () => {
  it('is a valid user-only skill that opens the continue link for this session', () => {
    const text = transferSkillText('vscode-insiders');
    const link = `vscode-insiders://${EXTENSION_ID}/continue?session=\${CLAUDE_SESSION_ID}`;
    expect(text).toContain(`name: ${SKILL_NAME}\n`);
    expect(text).toContain('disable-model-invocation: true\n');
    expect(text).toContain(
      `!\`code --open-url "${link}" 2>/dev/null || open "${link}" 2>/dev/null || xdg-open "${link}"\``,
    );
    expect(validateSkillFile(text)).toStrictEqual([]);
  });
});

async function setup(alive: () => boolean): Promise<{
  readonly rt: ReturnType<typeof makeApp>['app']['runtime'];
  readonly env: Awaited<ReturnType<typeof makeEnv>>;
  readonly killed: NodeJS.Signals[];
  readonly waits: number[];
}> {
  const env = await makeEnv();
  const killed: NodeJS.Signals[] = [];
  const waits: number[] = [];
  const { app } = makeApp(env, {
    deps: {
      isAlive: alive,
      kill: (_pid, signal): void => {
        killed.push(signal);
      },
      delay: async (ms): Promise<void> => {
        waits.push(ms);
        await Promise.resolve();
      },
    },
  });
  return { rt: app.runtime, env, killed, waits };
}

describe('clearOtherCopy', () => {
  it('is clear when no other copy is running', async () => {
    const { rt, env } = await setup(() => true);
    expect(await clearOtherCopy(rt, undefined, 'T')).toBe(true);
    expect(await clearOtherCopy(rt, live({ alive: false }), 'T')).toBe(true);
    expect(await clearOtherCopy(rt, live({ pid: null }), 'T')).toBe(true);
    expect(env.host.questions).toStrictEqual([]);
  });

  it('stops the other copy with SIGTERM and waits for it to exit', async () => {
    let checks = 0;
    const { rt, env, killed, waits } = await setup(() => {
      checks += 1;
      return checks < 3;
    });
    env.host.confirmAnswers.push(true);
    expect(await clearOtherCopy(rt, live({}), 'Work')).toBe(true);
    expect(killed).toStrictEqual(['SIGTERM']);
    expect(waits).toStrictEqual([250, 250]);
    expect(env.host.warnings).toStrictEqual([]);
  });

  it('gives up with a warning when the other copy will not exit', async () => {
    const { rt, env, waits } = await setup(() => true);
    env.host.confirmAnswers.push(true);
    expect(await clearOtherCopy(rt, live({ pid: 7 }), 'Work')).toBe(false);
    expect(waits).toHaveLength(EXIT_WAIT_MS / 250);
    expect(env.host.warnings).toStrictEqual([
      'Claude (pid 7) did not exit, so Overlord did not continue it. Close that terminal and try again.',
    ]);
  });

  it('accepts an exit that lands on the last check', async () => {
    let checks = 0;
    const { rt, env } = await setup(() => {
      checks += 1;
      return checks <= EXIT_WAIT_MS / 250;
    });
    env.host.confirmAnswers.push(true);
    expect(await clearOtherCopy(rt, live({}), 'Work')).toBe(true);
  });
});

describe('defaultDelay', () => {
  it('waits on a real timer', async () => {
    const start = Date.now();
    await defaultDelay(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

describe('installing /overlord', () => {
  it('asks first and writes nothing when told no', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.installTransferSkill('vscode');
    const file = transferSkillPath(app.runtime);
    expect(file).toBe(path.join(env.paths.userSkillsDir, 'overlord', 'SKILL.md'));
    expect(env.host.questions).toStrictEqual([
      {
        message: `Add the /overlord command to Claude Code? It writes ${file}.`,
        action: 'Add /overlord',
      },
    ]);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('writes the skill when told yes', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    env.host.confirmAnswers.push(true);
    await app.installTransferSkill('vscode');
    const text = await readFile(transferSkillPath(app.runtime), 'utf8');
    expect(text).toBe(transferSkillText('vscode'));
    expect(env.host.infos).toStrictEqual([
      'Added /overlord. Type it in any Claude Code session to move it here.',
    ]);
  });

  it('reports a write that fails', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    // A file where the skills folder should be makes mkdir fail.
    await writeText(env.paths.userSkillsDir, '');
    env.host.confirmAnswers.push(true);
    await app.installTransferSkill('vscode');
    expect(env.host.errors).toHaveLength(1);
    expect(env.host.errors[0]).toMatch(/^Could not add \/overlord: /u);
  });
});
