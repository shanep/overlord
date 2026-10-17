import { describe, expect, it } from 'vitest';

import { catalogSources, entryGroup, repoSources, SKILLS_SH } from './sources.js';

function source(kind: 'skill' | 'agent', id: string): ReturnType<typeof repoSources>[number] {
  const found = repoSources(kind).find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no ${kind} source ${id}`);
  }
  return found;
}

describe('catalog sources', () => {
  it('offers the skills.sh search for skills only', () => {
    expect(catalogSources('skill').map((entry) => entry.id)).toStrictEqual([
      'anthropics/skills',
      'obra/superpowers',
      'wshobson/agents',
      SKILLS_SH,
    ]);
    expect(catalogSources('agent').map((entry) => [entry.id, entry.search])).toStrictEqual([
      ['VoltAgent/awesome-claude-code-subagents', false],
      ['wshobson/agents', false],
    ]);
  });

  it('finds skill folders and names their plugin', () => {
    const anthropic = source('skill', 'anthropics/skills');
    expect(entryGroup(anthropic, 'skills/pdf/SKILL.md')).toBe('');
    expect(entryGroup(anthropic, 'skills/pdf/reference.md')).toBeNull();
    expect(entryGroup(anthropic, 'skills/pdf/nested/SKILL.md')).toBeNull();
    const plugins = source('skill', 'wshobson/agents');
    expect(entryGroup(plugins, 'plugins/python/skills/async/SKILL.md')).toBe('python');
    expect(entryGroup(plugins, 'plugins/python/agents/pro.md')).toBeNull();
  });

  it('finds agent files, drops category numbers and skips READMEs', () => {
    const volt = source('agent', 'VoltAgent/awesome-claude-code-subagents');
    expect(entryGroup(volt, 'categories/01-core-development/api-designer.md')).toBe(
      'core-development',
    );
    expect(entryGroup(volt, 'categories/01-core-development/README.md')).toBeNull();
    expect(entryGroup(volt, 'README.md')).toBeNull();
    const plugins = source('agent', 'wshobson/agents');
    expect(entryGroup(plugins, 'plugins/agent-teams/agents/team-debugger.md')).toBe('agent-teams');
  });
});
