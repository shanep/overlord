import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE } from '../../shared/agents.js';

import { claudeCode } from './claude/index.js';
import { agentInfo, AgentRegistry, detectAgents } from './registry.js';
import type { AgentAdapter, DetectInput, Detected } from './types.js';

import { agents } from './index.js';

function fake(id: string, bin: string | null): AgentAdapter & { readonly seen: DetectInput[] } {
  const seen: DetectInput[] = [];
  return {
    ...claudeCode,
    id,
    name: `Agent ${id}`,
    short: id,
    seen,
    detect: async (input): Promise<Detected> => {
      await Promise.resolve();
      seen.push(input);
      return { bin, version: bin === null ? null : '1.0.0' };
    },
  };
}

describe('AgentRegistry', () => {
  it('finds adapters by id and lists them in order', () => {
    const one = fake('one', null);
    const two = fake('two', null);
    const registry = new AgentRegistry([one, two]);
    expect(registry.get('two')).toBe(two);
    expect(registry.get('three')).toBeNull();
    expect(registry.list()).toStrictEqual([one, two]);
  });

  it('lists custom agents after the built-in ones and drops one that takes a used id', () => {
    const one = fake('one', null);
    const registry = new AgentRegistry([one]);
    const custom = fake('custom', null);
    registry.setCustom([custom, fake('one', null), fake('custom', null)]);
    expect(registry.list()).toStrictEqual([one, custom]);
    expect(registry.get('one')).toBe(one);
    expect(registry.get('custom')).toBe(custom);
    expect([...registry.builtInIds()]).toStrictEqual(['one']);
    registry.setCustom([]);
    expect(registry.get('custom')).toBeNull();
  });

  it('keeps a copy with a changed built-in in step with later custom agents', () => {
    const one = fake('one', null);
    const registry = new AgentRegistry([one, fake('two', null)]);
    const copy = registry.withBuiltIn('one', (adapter) => ({ ...adapter, name: 'Changed' }));
    expect(copy.get('one')?.name).toBe('Changed');
    expect(registry.get('one')).toBe(one);
    const custom = fake('custom', null);
    registry.setCustom([custom]);
    expect(copy.list().map((adapter) => adapter.id)).toStrictEqual(['one', 'two', 'custom']);
    expect(copy.get('custom')).toBe(custom);
  });

  it('registers Claude Code', () => {
    expect(agents.get(CLAUDE_CODE)).toBe(claudeCode);
  });
});

describe('agentInfo', () => {
  it('describes an adapter, not installed until detected', () => {
    expect(agentInfo(claudeCode)).toStrictEqual({
      id: 'claude-code',
      name: 'Claude Code',
      short: 'Claude',
      icon: 'sparkle',
      installed: false,
      version: null,
      capabilities: claudeCode.capabilities,
      permissionModes: claudeCode.modes.permission,
      effortLevels: claudeCode.modes.effort,
    });
    const found = agentInfo(claudeCode, { bin: '/bin/claude', version: '2.0.0' });
    expect(found.installed).toBe(true);
    expect(found.version).toBe('2.0.0');
  });
});

describe('detectAgents', () => {
  it('detects each agent with its own path', async () => {
    const one = fake('one', '/bin/one');
    const two = fake('two', null);
    const infos = await detectAgents(new AgentRegistry([one, two]), {
      env: { PATH: '/bin' },
      platform: 'linux',
      pathFor: (id) => (id === 'one' ? '/opt/one' : ''),
    });
    expect(infos.map((info) => [info.id, info.installed, info.version])).toStrictEqual([
      ['one', true, '1.0.0'],
      ['two', false, null],
    ]);
    expect(one.seen).toStrictEqual([
      { env: { PATH: '/bin' }, platform: 'linux', path: '/opt/one' },
    ]);
    expect(two.seen[0]?.path).toBe('');
  });
});
