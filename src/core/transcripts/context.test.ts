import { describe, expect, it } from 'vitest';

import { ContextTracker, listedDescriptionChars, skillSource, stripMcpHeader } from './context.js';
import type { Attachment } from './schemas.js';

const IDS = { sessionId: 's1', agentId: 'a1' };

function tracker(...items: readonly [Attachment, number | null][]): ContextTracker {
  const context = new ContextTracker();
  for (const [attachment, at] of items) {
    context.apply(attachment, at);
  }
  return context;
}

describe('ContextTracker', () => {
  it('starts empty', () => {
    expect(new ContextTracker().snapshot(IDS, 'fallback')).toStrictEqual({
      sessionId: 's1',
      agentId: 'a1',
      at: 0,
      systemPrompt: null,
      model: 'fallback',
      loaded: [],
      skipped: [],
      skills: [],
      agentTypes: [],
      mcpServers: [],
      deferredTools: [],
      environment: {},
      weights: [],
    });
  });

  it('ignores queued commands and keeps the time of the last context change', () => {
    const context = new ContextTracker();
    expect(context.apply({ type: 'queued_command', prompt: 'x' }, 50)).toBe(false);
    expect(context.snapshot(IDS, null).at).toBe(0);
    expect(context.apply({ type: 'prompt_snapshot', systemPrompt: ['a'] }, 70)).toBe(true);
    expect(context.apply({ type: 'prompt_snapshot', systemPrompt: ['b', 'c'] }, null)).toBe(true);
    const snapshot = context.snapshot(IDS, null);
    expect(snapshot.at).toBe(70);
    expect(snapshot.systemPrompt).toStrictEqual(['b', 'c']);
  });

  it('maps instruction files to session start loads and drops unknown tiers', () => {
    const snapshot = tracker([
      {
        type: 'instructions',
        files: [
          { path: '/home/CLAUDE.md', type: 'User', content: 'héllo' },
          { path: '/repo/CLAUDE.md', type: 'Project', content: 'abc' },
          { path: '/odd.md', type: 'Galaxy', content: 'x' },
        ],
        removed: [],
        reason: null,
      },
      100,
    ]).snapshot(IDS, null);
    expect(snapshot.loaded).toStrictEqual([
      {
        path: '/home/CLAUDE.md',
        tier: 'User',
        reason: 'session_start',
        triggerPath: null,
        parentPath: null,
        globs: [],
        bytes: 6,
        differsFromDisk: null,
        loadedAt: 100,
      },
      {
        path: '/repo/CLAUDE.md',
        tier: 'Project',
        reason: 'session_start',
        triggerPath: null,
        parentPath: null,
        globs: [],
        bytes: 3,
        differsFromDisk: null,
        loadedAt: 100,
      },
    ]);
  });

  it('applies removals and a known reload reason', () => {
    const snapshot = tracker(
      [
        {
          type: 'instructions',
          files: [
            { path: '/a.md', type: 'Managed', content: '' },
            { path: '/b.md', type: 'Local', content: '' },
          ],
          removed: [],
        },
        1,
      ],
      [
        {
          type: 'instructions',
          files: [{ path: '/c.md', type: 'AutoMem', content: 'z' }],
          removed: ['/a.md'],
          reason: 'compact',
        },
        2,
      ],
    ).snapshot(IDS, null);
    expect(
      snapshot.loaded.map((item) => [item.path, item.tier, item.reason, item.loadedAt]),
    ).toStrictEqual([
      ['/b.md', 'Local', 'session_start', 1],
      ['/c.md', 'AutoMem', 'compact', 2],
    ]);
  });

  it('treats an unknown reload reason as session start', () => {
    const snapshot = tracker([
      {
        type: 'instructions',
        files: [{ path: '/a.md', type: 'User', content: '' }],
        removed: [],
        reason: 'mystery',
      },
      1,
    ]).snapshot(IDS, null);
    expect(snapshot.loaded[0]?.reason).toBe('session_start');
  });

  it('records nested memory with its disk drift flag', () => {
    const snapshot = tracker(
      [
        {
          type: 'nested_memory',
          path: '/repo/sub/CLAUDE.md',
          content: {
            path: '/repo/sub/real.md',
            type: 'Project',
            content: 'abcd',
            contentDiffersFromDisk: true,
          },
        },
        5,
      ],
      [
        {
          type: 'nested_memory',
          path: '/repo/x/CLAUDE.md',
          content: { type: 'Local', content: '' },
        },
        6,
      ],
      [{ type: 'nested_memory', path: '/nope', content: { type: 'Bogus', content: '' } }, 7],
    ).snapshot(IDS, null);
    expect(snapshot.loaded).toStrictEqual([
      {
        path: '/repo/sub/real.md',
        tier: 'Project',
        reason: 'nested_traversal',
        triggerPath: null,
        parentPath: null,
        globs: [],
        bytes: 4,
        differsFromDisk: true,
        loadedAt: 5,
      },
      {
        path: '/repo/x/CLAUDE.md',
        tier: 'Local',
        reason: 'nested_traversal',
        triggerPath: null,
        parentPath: null,
        globs: [],
        bytes: 0,
        differsFromDisk: null,
        loadedAt: 6,
      },
    ]);
    expect(snapshot.at).toBe(7);
  });

  it('tracks listed and invoked skills', () => {
    const snapshot = tracker(
      [
        {
          type: 'skill_listing',
          names: ['canvas', 'anthropic-skills:pptx'],
          content: '- canvas: Work with Canvas\n- anthropic-skills:pptx: Slides',
        },
        1,
      ],
      [
        {
          type: 'invoked_skills',
          skills: [
            { name: 'canvas', path: 'userSettings:canvas' },
            { name: 'local', path: '/repo/.claude/skills/local/SKILL.md' },
            { name: 'bare', path: null },
          ],
        },
        2,
      ],
    ).snapshot(IDS, null);
    expect(snapshot.skills).toStrictEqual([
      {
        name: 'canvas',
        source: 'user',
        path: null,
        listed: true,
        invoked: true,
        descriptionChars: 16,
      },
      {
        name: 'anthropic-skills:pptx',
        source: 'plugin',
        path: null,
        listed: true,
        invoked: false,
        descriptionChars: 6,
      },
      {
        name: 'local',
        source: 'unknown',
        path: '/repo/.claude/skills/local/SKILL.md',
        listed: false,
        invoked: true,
        descriptionChars: 0,
      },
      {
        name: 'bare',
        source: 'unknown',
        path: null,
        listed: false,
        invoked: true,
        descriptionChars: 0,
      },
    ]);
  });

  it('returns copies of skills so callers cannot change tracker state', () => {
    const context = tracker([{ type: 'skill_listing', names: ['a'], content: '' }, 1]);
    const first = context.snapshot(IDS, null).skills[0];
    expect(first).toBeDefined();
    context.apply({ type: 'invoked_skills', skills: [{ name: 'a', path: null }] }, 2);
    expect(first?.invoked).toBe(false);
    expect(context.snapshot(IDS, null).skills[0]?.invoked).toBe(true);
  });

  it('applies MCP instruction deltas', () => {
    const snapshot = tracker(
      [
        {
          type: 'mcp_instructions_delta',
          addedNames: ['github', 'docs', 'extra'],
          addedBlocks: ['## github\nUse gh.', 'no header'],
          removedNames: [],
        },
        1,
      ],
      [
        { type: 'mcp_instructions_delta', addedNames: [], addedBlocks: [], removedNames: ['docs'] },
        2,
      ],
    ).snapshot(IDS, null);
    expect(snapshot.mcpServers).toStrictEqual([
      { name: 'github', instructions: 'Use gh.' },
      { name: 'extra', instructions: '' },
    ]);
  });

  it('applies deferred tool and agent type deltas in order without duplicates', () => {
    const snapshot = tracker(
      [{ type: 'deferred_tools_delta', addedNames: ['A', 'B', 'A'], removedNames: [] }, 1],
      [{ type: 'deferred_tools_delta', addedNames: ['C'], removedNames: ['A'] }, 2],
      [{ type: 'agent_listing_delta', addedTypes: ['Explore', 'Plan'], removedTypes: [] }, 3],
      [{ type: 'agent_listing_delta', addedTypes: [], removedTypes: ['Plan'] }, 4],
    ).snapshot(IDS, null);
    expect(snapshot.deferredTools).toStrictEqual(['B', 'C']);
    expect(snapshot.agentTypes).toStrictEqual(['Explore']);
  });

  it('replaces the environment block with display strings', () => {
    const snapshot = tracker(
      [{ type: 'environment', snapshot: { old: 'gone' } }, 1],
      [
        {
          type: 'environment',
          snapshot: { platform: 'darwin', isGitRepo: true, dirs: ['/a', '/b'] },
        },
        2,
      ],
    ).snapshot(IDS, null);
    expect(snapshot.environment).toStrictEqual({
      platform: 'darwin',
      isGitRepo: 'true',
      dirs: '/a, /b',
    });
  });

  it('prefers the model attachment over the fallback', () => {
    const snapshot = tracker([
      { type: 'model', identity: { modelId: 'claude-opus-5-5' } },
      1,
    ]).snapshot(IDS, 'other');
    expect(snapshot.model).toBe('claude-opus-5-5');
  });
});

describe('skillSource', () => {
  it('maps settings prefixes', () => {
    expect(skillSource('a', 'userSettings:a')).toBe('user');
    expect(skillSource('a', 'projectSettings:a')).toBe('project');
    expect(skillSource('a', 'localSettings:a')).toBe('project');
    expect(skillSource('a', 'policySettings:a')).toBe('managed');
    expect(skillSource('a', 'plugin:a')).toBe('plugin');
  });

  it('recognizes synced and plugin paths', () => {
    expect(skillSource('a', '/home/.claude/skills/synced/x/a/SKILL.md')).toBe('claude-ai');
    expect(skillSource('a', '/home/.claude/plugins/cache/p/a/SKILL.md')).toBe('plugin');
  });

  it('falls back on the name', () => {
    expect(skillSource('ns:a', '/somewhere/a')).toBe('plugin');
    expect(skillSource('ns:a', null)).toBe('plugin');
    expect(skillSource('a', 'mystery:a')).toBe('unknown');
    expect(skillSource('a', null)).toBe('unknown');
    expect(skillSource('a', '')).toBe('unknown');
    expect(skillSource('a', 'constructor:a')).toBe('unknown');
    expect(skillSource('a', '/x/userSettings:a')).toBe('unknown');
  });
});

describe('listedDescriptionChars', () => {
  it('measures the description after "- name: "', () => {
    expect(listedDescriptionChars('- a: one\n- ab: three', 'ab')).toBe(5);
    expect(listedDescriptionChars('- a: one\n- ab: three', 'a')).toBe(3);
    expect(listedDescriptionChars('- a:none', 'a')).toBe(0);
    expect(listedDescriptionChars('', 'a')).toBe(0);
  });
});

describe('stripMcpHeader', () => {
  it('removes only a matching header line', () => {
    expect(stripMcpHeader('## gh\nbody', 'gh')).toBe('body');
    expect(stripMcpHeader('## other\nbody', 'gh')).toBe('## other\nbody');
    expect(stripMcpHeader('body', 'gh')).toBe('body');
  });
});
