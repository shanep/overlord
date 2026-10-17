import { describe, expect, it } from 'vitest';

import type { LaunchProfile } from '../../shared/model.js';

import { configArgs, toExtraArgs, toLaunchOptions } from './launch.js';

function profile(id: string, partial: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id,
    agent: 'claude-code',
    name: `Profile ${id}`,
    model: null,
    effort: null,
    permissionMode: null,
    env: {},
    extraArgs: [],
    ...partial,
  };
}

describe('launch', () => {
  describe('toExtraArgs', () => {
    it.each([
      [[], {}],
      [['--verbose'], { verbose: null }],
      [['--max-turns', '5'], { 'max-turns': '5' }],
      [['--debug=api,mcp'], { debug: 'api,mcp' }],
      [['--empty='], { empty: '' }],
      [['--a', '--b', 'x', '--c'], { a: null, b: 'x', c: null }],
      [['--a', '-p', 'stray'], { a: null }],
      [['-w', 'name', '--tmux'], { tmux: null }],
      [['positional', '--', '--x', 'y'], { x: 'y' }],
    ])('turns %j into %j', (args, expected) => {
      expect(toExtraArgs(args)).toStrictEqual(expected);
    });
  });

  describe('toLaunchOptions', () => {
    it('leaves out unset fields', () => {
      const options = toLaunchOptions(profile('a'));
      expect(options).toStrictEqual({ env: {}, extraArgs: {}, config: [] });
      expect('model' in options).toBe(false);
      expect('effort' in options).toBe(false);
      expect('permissionMode' in options).toBe(false);
    });

    it('copies every set field', () => {
      const env = { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4' };
      const options = toLaunchOptions(
        profile('a', {
          model: 'opus',
          effort: 'xhigh',
          permissionMode: 'acceptEdits',
          env,
          extraArgs: ['--max-turns', '9'],
        }),
      );
      expect(options).toStrictEqual({
        model: 'opus',
        effort: 'xhigh',
        permissionMode: 'acceptEdits',
        env,
        extraArgs: { 'max-turns': '9' },
        config: [],
      });
      expect(options.env).not.toBe(env);
    });
  });

  describe('configArgs', () => {
    it('turns config overrides into -c key=value pairs with TOML values', () => {
      expect(
        configArgs([
          { key: ['model'], value: 'o3' },
          { key: ['sandbox_workspace_write', 'network_access'], value: true },
          { key: ['mcp_servers', 'docs.server', 'args'], value: ['-y', 'docs'] },
        ]),
      ).toStrictEqual([
        '-c',
        'model="o3"',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '-c',
        'mcp_servers."docs.server".args=["-y", "docs"]',
      ]);
      expect(configArgs([{ key: ['a'], value: 1 }], '--config')).toStrictEqual(['--config', 'a=1']);
      expect(configArgs([])).toStrictEqual([]);
    });
  });
});
