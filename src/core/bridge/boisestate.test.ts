import { describe, expect, it } from 'vitest';

import {
  applyBridge,
  bearerEnv,
  BOISESTATE_PROFILE,
  BRIDGE_BASE_URL,
  BRIDGE_ARGS,
  needsBridge,
  parseReadyLine,
} from './boisestate.js';

describe('needsBridge', () => {
  it('is true only when the base URL is the placeholder', () => {
    expect(needsBridge({ ANTHROPIC_BASE_URL: BRIDGE_BASE_URL })).toBe(true);
    expect(needsBridge({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe(false);
    expect(needsBridge({})).toBe(false);
  });
});

describe('applyBridge', () => {
  it('swaps in the real URL and sets the token as the api key', () => {
    const result = applyBridge(
      { ANTHROPIC_BASE_URL: BRIDGE_BASE_URL, FOO: 'bar' },
      { baseUrl: 'http://127.0.0.1:4321', token: 'tok' },
    );
    expect(result).toStrictEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321',
      ANTHROPIC_API_KEY: 'tok',
      FOO: 'bar',
    });
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
  it('opts into the bridge on Opus 5.5', () => {
    expect(BOISESTATE_PROFILE.id).toBe('boisestate');
    expect(BOISESTATE_PROFILE.model).toBe('claude-opus-5-5');
    expect(BOISESTATE_PROFILE.env['ANTHROPIC_BASE_URL']).toBe(BRIDGE_BASE_URL);
    expect(needsBridge(BOISESTATE_PROFILE.env)).toBe(true);
  });
});

describe('bearerEnv', () => {
  it('moves the token from the api key to the bearer token', () => {
    expect(
      bearerEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321', ANTHROPIC_API_KEY: 'tok' }),
    ).toStrictEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321',
      ANTHROPIC_AUTH_TOKEN: 'tok',
    });
  });

  it('leaves an env with no api key alone', () => {
    expect(bearerEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321' })).toStrictEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321',
    });
  });
});

describe('BRIDGE_ARGS', () => {
  it('start the session on the bridge model, with no MCP servers', () => {
    expect(BRIDGE_ARGS).toStrictEqual(['--model', BOISESTATE_PROFILE.model, '--strict-mcp-config']);
  });
});
