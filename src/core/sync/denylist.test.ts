import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_JSON_ALLOWLIST,
  isDeniedKey,
  isDeniedPath,
  pickAllowedClaudeJson,
  stripDeniedKeys,
} from './denylist.js';
import { fakePaths } from './test-helpers/fixtures.js';

const paths = fakePaths('/h');

describe('denied keys', () => {
  it('denies account data and anything with token in its name', () => {
    for (const key of [
      'oauthAccount',
      'userID',
      'machineID',
      'anonymousId',
      'primaryApiKey',
      'customApiKeyResponses',
    ]) {
      expect(isDeniedKey(key)).toBe(true);
    }
    expect(isDeniedKey('accessToken')).toBe(true);
    expect(isDeniedKey('GITHUB_TOKEN')).toBe(true);
    expect(isDeniedKey('token')).toBe(true);
  });

  it('allows ordinary settings, including token counts', () => {
    expect(isDeniedKey('model')).toBe(false);
    expect(isDeniedKey('maxTokens')).toBe(false);
    expect(isDeniedKey('CLAUDE_CODE_MAX_OUTPUT_TOKENS')).toBe(false);
  });

  it('strips denied keys at any depth', () => {
    const value = {
      model: 'opus',
      oauthAccount: { email: 'x' },
      env: { GITHUB_TOKEN: 'x', MAX_TOKENS: '5' },
      list: [{ userID: 1, keep: 2 }],
    };
    expect(stripDeniedKeys(value)).toStrictEqual({
      model: 'opus',
      env: { MAX_TOKENS: '5' },
      list: [{ keep: 2 }],
    });
    expect(stripDeniedKeys('x')).toBe('x');
  });
});

describe('~/.claude.json allowlist', () => {
  it('reads only mcpServers', () => {
    expect(CLAUDE_JSON_ALLOWLIST).toStrictEqual(['mcpServers']);
    const raw = { mcpServers: { a: {} }, oauthAccount: {}, projects: { '/x': {} }, userID: 'u' };
    expect(pickAllowedClaudeJson(raw)).toStrictEqual({ mcpServers: { a: {} } });
    expect(pickAllowedClaudeJson({ mcpServers: 'oops' })).toStrictEqual({});
    expect(pickAllowedClaudeJson(null)).toStrictEqual({});
  });
});

describe('denied paths', () => {
  it('denies credentials, keys and ~/.claude.json', () => {
    expect(isDeniedPath('/h/.claude/.credentials.json', paths)).toBe(true);
    expect(isDeniedPath('/repo/skills/x/.credentials.json', paths)).toBe(true);
    expect(isDeniedPath('/h/.claude.json', paths)).toBe(true);
    expect(isDeniedPath('/h/.claude.json.backup', paths)).toBe(true);
    expect(isDeniedPath('/h/.ssh/id_ed25519', paths)).toBe(true);
    expect(isDeniedPath('/h/certs/server.pem', paths)).toBe(true);
    expect(isDeniedPath('/h/x.key', paths)).toBe(true);
  });

  it('denies caches, history and transcripts but allows memory and content', () => {
    for (const name of [
      'backups/a',
      'cache',
      'history.jsonl',
      'sessions/1.json',
      'stats-cache.json',
      'todos/x',
      'file-history/y',
    ]) {
      expect(isDeniedPath(path.join('/h/.claude', name), paths)).toBe(true);
    }
    expect(isDeniedPath('/h/.claude/projects/-x/abc.jsonl', paths)).toBe(true);
    expect(isDeniedPath('/h/.claude/projects/-x', paths)).toBe(true);
    expect(isDeniedPath('/h/.claude/projects/-x/memory/MEMORY.md', paths)).toBe(false);
    expect(isDeniedPath('/h/.claude/CLAUDE.md', paths)).toBe(false);
    expect(isDeniedPath('/h/.claude/skills/a/SKILL.md', paths)).toBe(false);
    expect(isDeniedPath('/h/.claude', paths)).toBe(false);
    expect(isDeniedPath('/h/notes/cache', paths)).toBe(false);
  });
});
