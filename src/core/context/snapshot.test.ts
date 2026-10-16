import { describe, expect, it } from 'vitest';

import type {
  ContextSnapshot,
  LoadedInstruction,
  SkillEntry,
  SkippedCandidate,
} from '../../shared/model.js';

import type { ExpectedInstruction } from './resolve.js';
import { estimateTokens, mergeIntoSnapshot, WEIGHT_LABELS } from './snapshot.js';

const BASE: ContextSnapshot = {
  sessionId: 's',
  agentId: 's',
  at: 1,
  systemPrompt: null,
  model: null,
  loaded: [],
  skipped: [],
  skills: [],
  agentTypes: [],
  mcpServers: [],
  deferredTools: [],
  environment: {},
  weights: [],
};

function loaded(
  filePath: string,
  bytes: number,
  tier: LoadedInstruction['tier'] = 'Project',
): LoadedInstruction {
  return {
    path: filePath,
    tier,
    reason: 'session_start',
    triggerPath: null,
    parentPath: null,
    globs: [],
    bytes,
    differsFromDisk: null,
    loadedAt: null,
  };
}

function expected(
  filePath: string,
  bytes: number,
  tier: LoadedInstruction['tier'] = 'Project',
): ExpectedInstruction {
  return {
    ...loaded(filePath, bytes, tier),
    mode: 'eager',
    detail: 'Loaded at launch.',
    observed: null,
  };
}

function skillEntry(
  name: string,
  listed: boolean,
  descriptionChars: number,
): SkillEntry & { readonly description: string } {
  return {
    name,
    source: 'user',
    path: null,
    listed,
    invoked: false,
    descriptionChars,
    description: 'extra field',
  };
}

const SKIPPED: SkippedCandidate[] = [
  {
    path: '/x',
    tier: 'Project',
    exists: false,
    code: 'missing',
    detail: 'The file does not exist.',
  },
];

describe('estimateTokens', () => {
  it('rounds four characters per token up', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
  });
});

describe('mergeIntoSnapshot', () => {
  it('fills loaded, skipped and skills, strips extra fields and estimates weights', () => {
    const snapshot = mergeIntoSnapshot(
      {
        ...BASE,
        systemPrompt: ['abcd', 'hello'],
        mcpServers: [{ name: 'm', instructions: 'x'.repeat(9) }],
      },
      {
        expected: [expected('/a', 10), expected('/b', 3), expected('/m', 8, 'AutoMem')],
        skipped: SKIPPED,
      },
      [skillEntry('one', true, 7), skillEntry('two', false, 100)],
    );
    expect(snapshot.loaded).toStrictEqual([
      loaded('/a', 10),
      loaded('/b', 3),
      loaded('/m', 8, 'AutoMem'),
    ]);
    expect(snapshot.skipped).toStrictEqual(SKIPPED);
    expect(snapshot.skills).toStrictEqual([
      {
        name: 'one',
        source: 'user',
        path: null,
        listed: true,
        invoked: false,
        descriptionChars: 7,
      },
      {
        name: 'two',
        source: 'user',
        path: null,
        listed: false,
        invoked: false,
        descriptionChars: 100,
      },
    ]);
    expect(snapshot.weights).toStrictEqual([
      { label: 'System prompt', tokens: 3, estimated: true },
      { label: 'Memory files', tokens: 4, estimated: true },
      { label: 'Auto memory', tokens: 2, estimated: true },
      { label: 'Skills', tokens: 2, estimated: true },
      { label: 'MCP instructions', tokens: 3, estimated: true },
    ]);
    expect(snapshot.sessionId).toBe('s');
  });

  it('keeps what the base already knows', () => {
    const base: ContextSnapshot = {
      ...BASE,
      loaded: [loaded('/real', 400)],
      skills: [
        {
          name: 'kept',
          source: 'plugin',
          path: null,
          listed: true,
          invoked: true,
          descriptionChars: 40,
        },
      ],
      weights: [{ label: WEIGHT_LABELS.memory, tokens: 999, estimated: false }],
    };
    const snapshot = mergeIntoSnapshot(base, { expected: [expected('/a', 10)], skipped: [] }, [
      skillEntry('x', true, 1),
    ]);
    expect(snapshot.loaded).toStrictEqual(base.loaded);
    expect(snapshot.skills).toStrictEqual(base.skills);
    expect(snapshot.skipped).toStrictEqual([]);
    expect(snapshot.weights).toStrictEqual([
      { label: 'Memory files', tokens: 999, estimated: false },
      { label: 'Skills', tokens: 10, estimated: true },
    ]);
  });

  it('adds no weight for an empty category and defaults skills to none', () => {
    const snapshot = mergeIntoSnapshot(BASE, { expected: [], skipped: [] });
    expect(snapshot.weights).toStrictEqual([]);
    expect(snapshot.skills).toStrictEqual([]);
    expect(snapshot.loaded).toStrictEqual([]);
  });
});
