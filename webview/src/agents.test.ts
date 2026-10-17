import { describe, expect, it } from 'vitest';

import { codexAgent, twoAgents } from '../test/fixtures-agents.js';

import { findAgent, knowsClaude, offeredAgents, showsAgent, soleAgent } from './agents.js';
import { CLAUDE_FALLBACK } from './claude-fallback.js';

/** An id that is unset at run time, as on a message from an older host. */
function missingId(): string | undefined {
  return new Map<string, string>().get('missing');
}

describe('agents', () => {
  it('looks agents up by id, with Claude Code for an unset id or an empty list', () => {
    expect(findAgent(twoAgents, 'codex')).toBe(codexAgent);
    expect(findAgent([], CLAUDE_FALLBACK.id)).toBe(CLAUDE_FALLBACK);
    expect(findAgent(twoAgents, missingId())).toBe(CLAUDE_FALLBACK);
    expect(findAgent([codexAgent], 'claude-code')).toBe(CLAUDE_FALLBACK);
  });

  it('names an agent the host did not describe by its id and offers nothing for it', () => {
    const unknown = findAgent(twoAgents, 'gemini');
    expect(unknown.short).toBe('gemini');
    expect(unknown.capabilities.costUsd).toBe(false);
    expect(unknown.capabilities.handoffs).toStrictEqual([]);
  });

  it('offers installed agents and Claude Code, and names the agent only when it is the one', () => {
    const missing = { ...codexAgent, installed: false };
    const claude = { ...CLAUDE_FALLBACK, installed: false };
    expect(offeredAgents([claude, missing]).map((agent) => agent.id)).toStrictEqual([
      'claude-code',
    ]);
    expect(soleAgent([claude, missing])?.name).toBe('Claude Code');
    expect(soleAgent(twoAgents)).toBeNull();
    expect(soleAgent([])).toBe(CLAUDE_FALLBACK);
  });

  it('knows Claude Code from the list, or from an empty one', () => {
    expect(knowsClaude([])).toBe(true);
    expect(knowsClaude(twoAgents)).toBe(true);
    expect(knowsClaude([codexAgent])).toBe(false);
  });

  it('names the agent on every row once the list mixes agents, and always for others', () => {
    expect(showsAgent('claude-code', ['claude-code', 'claude-code'])).toBe(false);
    expect(showsAgent('claude-code', ['claude-code', 'codex'])).toBe(true);
    expect(showsAgent('codex', ['codex'])).toBe(true);
  });
});
