// The webview pictures Claude Code on its own until the host sends the agents
// list, so its copy must match what the adapter tells the webview.

import { describe, expect, it } from 'vitest';

import { claudeCode } from '../../src/core/agents/claude/index.js';
import { agentInfo } from '../../src/core/agents/registry.js';
import { CLAUDE_FALLBACK } from '../../webview/src/claude-fallback.js';

describe('the webview Claude Code fallback', () => {
  it('matches the adapter, installed', () => {
    expect(CLAUDE_FALLBACK).toStrictEqual({ ...agentInfo(claudeCode), installed: true });
  });
});
