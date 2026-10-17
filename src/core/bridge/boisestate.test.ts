import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE, CODEX } from '../../shared/agents.js';

import { BOISESTATE, BOISESTATE_PROFILE, BRIDGE_BASE_URL, parseReadyLine } from './boisestate.js';

const ENDPOINT = { baseUrl: 'http://127.0.0.1:4321', token: 'tok' };

describe('BOISESTATE', () => {
  it('serves Claude Code only', () => {
    expect(BOISESTATE.appliesTo(CLAUDE_CODE)).toBe(true);
    expect(BOISESTATE.appliesTo(CODEX)).toBe(false);
  });

  it('gives a run the token as the api key', () => {
    expect(BOISESTATE.env(CLAUDE_CODE, ENDPOINT, 'run')).toStrictEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321',
      ANTHROPIC_API_KEY: 'tok',
    });
  });

  it('gives a tab the token as a bearer token, so the CLI does not ask to approve it', () => {
    expect(BOISESTATE.env(CLAUDE_CODE, ENDPOINT, 'tab')).toStrictEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321',
      ANTHROPIC_AUTH_TOKEN: 'tok',
    });
  });

  it('starts a tab on the bridge model, with no MCP servers and not in auto mode, in the foreground', () => {
    expect(BOISESTATE.tabArgs(CLAUDE_CODE)).toStrictEqual([
      '--model',
      BOISESTATE_PROFILE.model,
      '--strict-mcp-config',
      '--permission-mode',
      'default',
    ]);
    expect(BOISESTATE.noMcp).toBe(true);
    expect(BOISESTATE.windowBound).toBe(true);
    expect(BOISESTATE.safeMode).toBe('default');
  });

  it('claims an env only when the base URL is the placeholder', () => {
    expect(BOISESTATE.claims({ ANTHROPIC_BASE_URL: BRIDGE_BASE_URL })).toBe(true);
    expect(BOISESTATE.claims({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe(false);
    expect(BOISESTATE.claims({})).toBe(false);
  });
});

describe('parseReadyLine', () => {
  it('reads the port from a ready line', () => {
    expect(parseReadyLine('{"ready":true,"port":59733}')).toBe(59_733);
    expect(parseReadyLine('  {"ready":true,"port":8080}  ')).toBe(8080);
  });

  it('returns null for blank, non-JSON, or non-ready lines', () => {
    expect(parseReadyLine('')).toBeNull();
    expect(parseReadyLine(' '.repeat(3))).toBeNull();
    expect(parseReadyLine('starting up')).toBeNull();
    expect(parseReadyLine('{"ready":false,"port":1}')).toBeNull();
    expect(parseReadyLine('{"ready":true}')).toBeNull();
    expect(parseReadyLine('{"ready":true,"port":0}')).toBeNull();
  });
});

describe('BOISESTATE_PROFILE', () => {
  it('runs Claude Code on the boisestate backend, on Opus 5.5', () => {
    expect(BOISESTATE_PROFILE.id).toBe('boisestate');
    expect(BOISESTATE_PROFILE.agent).toBe(CLAUDE_CODE);
    expect(BOISESTATE_PROFILE.backend).toBe(BOISESTATE.id);
    expect(BOISESTATE_PROFILE.model).toBe('claude-opus-5-5');
  });
});
