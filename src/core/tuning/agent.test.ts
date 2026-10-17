import { describe, expect, it } from 'vitest';

import { CODEX } from '../../shared/agents.js';
import { claudeCode } from '../agents/claude/index.js';

import type { TuningAgent } from './agent.js';
import { inAgentWords, ruleFits, ruleKnobs, tuningAgent } from './agent.js';

const CLAUDE = tuningAgent(claudeCode);

const OTHER: TuningAgent = {
  ...CLAUDE,
  id: CODEX,
  name: 'Codex CLI',
  short: 'Codex',
  capabilities: { ...CLAUDE.capabilities, cacheWrites: false },
  words: {
    instructionsFile: 'AGENTS.md',
    compactCommand: '/compact',
    clearCommand: '/new',
    rewind: null,
    taskList: 'update_plan',
    connectorExamples: null,
  },
  knobs: { 'huge-context': ['model_auto_compact_token_limit'] },
};

describe('inAgentWords', () => {
  it("leaves Claude Code's text alone and swaps the names for another agent", () => {
    const text = 'Put it in CLAUDE.md, run /clear, and Claude Code lets Claude start over.';
    expect(inAgentWords(text, CLAUDE)).toBe(text);
    expect(inAgentWords(text, OTHER)).toBe(
      'Put it in AGENTS.md, run /new, and Codex CLI lets Codex start over.',
    );
  });
});

describe('ruleFits', () => {
  it('fits every rule to Claude Code', () => {
    expect(ruleFits({ id: 'x', only: ['nobody'], needs: ['cacheWrites'] }, [], CLAUDE)).toBe(true);
  });

  it('skips rules for other agents, missing capabilities and missing commands', () => {
    expect(ruleFits({ id: 'x' }, ['Run /clear'], OTHER)).toBe(true);
    expect(ruleFits({ id: 'x', only: ['claude-code'] }, [], OTHER)).toBe(false);
    expect(ruleFits({ id: 'x', needs: ['cacheWrites'] }, [], OTHER)).toBe(false);
    const silent: TuningAgent = { ...OTHER, words: null };
    expect(ruleFits({ id: 'x' }, ['Run /compact'], silent)).toBe(false);
    expect(ruleFits({ id: 'x' }, ['Start a new session'], silent)).toBe(true);
  });
});

describe('ruleKnobs', () => {
  it("reads Claude Code's knobs from the rule and other agents' from their facet", () => {
    const rule = { id: 'huge-context', knobs: ['autoCompactWindow'] };
    expect(ruleKnobs(rule, CLAUDE)).toStrictEqual(['autoCompactWindow']);
    expect(ruleKnobs(rule, OTHER)).toStrictEqual(['model_auto_compact_token_limit']);
    expect(ruleKnobs({ id: 'rereads' }, OTHER)).toStrictEqual([]);
  });
});
