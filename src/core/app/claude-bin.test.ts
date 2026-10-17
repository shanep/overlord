import { describe, expect, it } from 'vitest';

import {
  agentEnabled,
  agentPath,
  claudePathSetting,
  executableFor,
  parseAgentSettings,
} from './claude-bin.js';

describe('parseAgentSettings', () => {
  it('reads path and enabled per agent, filling in what is left out', () => {
    expect(
      parseAgentSettings({
        'claude-code': { path: ' /opt/claude ' },
        copilot: { enabled: false },
        codex: { path: 3, enabled: 'yes' },
        junk: 'not an object',
      }),
    ).toStrictEqual({
      'claude-code': { path: '/opt/claude', enabled: true },
      copilot: { path: '', enabled: false },
      codex: { path: '', enabled: true },
    });
  });

  it('takes anything but an object as no settings', () => {
    expect(parseAgentSettings(null)).toStrictEqual({});
    expect(parseAgentSettings(['claude-code'])).toStrictEqual({});
  });
});

describe('claudePathSetting', () => {
  const agents = { 'claude-code': { path: '/agents/claude', enabled: true } };

  it('lets overlord.claudePath win when set, then overlord.agents, then the default', () => {
    expect(claudePathSetting('/set/claude', agents, 'claude')).toBe('/set/claude');
    expect(claudePathSetting(undefined, agents, 'claude')).toBe('/agents/claude');
    expect(claudePathSetting(undefined, {}, 'claude')).toBe('claude');
    expect(
      claudePathSetting(undefined, { 'claude-code': { path: '', enabled: true } }, 'claude'),
    ).toBe('claude');
  });
});

describe('agentPath and agentEnabled', () => {
  const settings = {
    claudePath: '/opt/claude',
    agents: {
      'claude-code': { path: '/ignored', enabled: false },
      copilot: { path: '/opt/copilot', enabled: true },
    },
  };

  it('takes Claude from claudePath and every other agent from overlord.agents', () => {
    expect(agentPath(settings, 'claude-code')).toBe('/opt/claude');
    expect(agentPath(settings, 'copilot')).toBe('/opt/copilot');
    expect(agentPath(settings, 'codex')).toBe('');
    expect(agentEnabled(settings, 'claude-code')).toBe(false);
    expect(agentEnabled(settings, 'codex')).toBe(true);
  });
});

describe('executableFor', () => {
  it('leaves a bare default name found nowhere to the caller, for any agent', () => {
    expect(executableFor('', { PATH: '' }, 'linux')).toBeNull();
    expect(executableFor('', { PATH: '' }, 'linux', 'copilot')).toBeNull();
    expect(executableFor('/opt/copilot', { PATH: '' }, 'linux', 'copilot')).toBe('/opt/copilot');
  });
});
