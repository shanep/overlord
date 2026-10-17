import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE, CODEX } from '../../shared/agents.js';

import {
  modeOn,
  BACKENDS,
  backendFor,
  backendIdOf,
  backendsFor,
  chosenBackend,
  findBackend,
} from './backends.js';
import { BOISESTATE, BRIDGE_BASE_URL } from './boisestate.js';

const PLACEHOLDER = { ANTHROPIC_BASE_URL: BRIDGE_BASE_URL };

describe('backendIdOf', () => {
  it('takes the backend field first', () => {
    expect(backendIdOf({ backend: 'boisestate', env: {} })).toBe('boisestate');
    expect(backendIdOf({ backend: 'other', env: PLACEHOLDER })).toBe('other');
  });

  it('reads the old ANTHROPIC_BASE_URL placeholder as the boisestate backend', () => {
    expect(backendIdOf({ env: PLACEHOLDER })).toBe('boisestate');
    expect(backendIdOf({ backend: '', env: PLACEHOLDER })).toBe('boisestate');
  });

  it('is null for the agent own account', () => {
    expect(backendIdOf({ env: {} })).toBeNull();
    expect(backendIdOf({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })).toBeNull();
  });
});

describe('backendFor', () => {
  it('finds a backend that serves the agent', () => {
    expect(backendFor('boisestate', CLAUDE_CODE)).toBe(BOISESTATE);
  });

  it('refuses an unknown backend, or one that does not serve the agent', () => {
    expect(() => backendFor('nope', CLAUDE_CODE)).toThrow('Unknown backend "nope"');
    expect(() => backendFor('boisestate', CODEX)).toThrow('does not run codex sessions');
  });
});

describe('chosenBackend', () => {
  it('resolves a profile with the field and one with only the placeholder alike', () => {
    expect(chosenBackend({ backend: 'boisestate', env: {} }, CLAUDE_CODE)).toBe(BOISESTATE);
    expect(chosenBackend({ env: PLACEHOLDER }, CLAUDE_CODE)).toBe(BOISESTATE);
    expect(chosenBackend({ env: {} }, CLAUDE_CODE)).toBeNull();
  });
});

describe('the backend list', () => {
  it('has boisestate as its only member, for Claude Code only', () => {
    expect(BACKENDS).toStrictEqual([BOISESTATE]);
    expect(backendsFor(CLAUDE_CODE)).toStrictEqual([BOISESTATE]);
    expect(backendsFor(CODEX)).toStrictEqual([]);
    expect(findBackend('boisestate')).toBe(BOISESTATE);
    expect(findBackend('nope')).toBeNull();
  });
});

describe('modeOn', () => {
  it("swaps auto mode, or no mode, for a backend's safe mode and keeps any other choice", () => {
    expect(modeOn(BOISESTATE, 'auto')).toBe('default');
    expect(modeOn(BOISESTATE, null)).toBe('default');
    expect(modeOn(BOISESTATE, 'plan')).toBe('plan');
    expect(modeOn({ ...BOISESTATE, safeMode: null }, 'auto')).toBe('auto');
    expect(modeOn(null, 'auto')).toBe('auto');
  });
});
