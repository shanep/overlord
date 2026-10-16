import { describe, expect, it } from 'vitest';

import { type Action, describeAction, summarizePlan } from './actions.js';

const home = '/h';

describe('describeAction', () => {
  it('describes every kind with home shortened to ~', () => {
    const cases: readonly (readonly [Action, string])[] = [
      [{ kind: 'mkdir', path: '/h/.claude/agents' }, 'mkdir   ~/.claude/agents'],
      [{ kind: 'backup', path: '/h/.claude/settings.json' }, 'backup  ~/.claude/settings.json'],
      [
        { kind: 'link', source: '/h/repo/global/CLAUDE.md', target: '/h/.claude/CLAUDE.md' },
        'link    ~/.claude/CLAUDE.md -> ~/repo/global/CLAUDE.md',
      ],
      [{ kind: 'copy', source: '/r/a', target: '/h/a' }, 'copy    /r/a to ~/a'],
      [
        { kind: 'generate-settings', target: '/h/.claude/settings.json', content: '{}' },
        'write   ~/.claude/settings.json (generated settings)',
      ],
      [{ kind: 'write-file', target: '/h/x.md', content: 'x' }, 'write   ~/x.md'],
      [{ kind: 'remove', path: '/h/x' }, 'remove  ~/x (backed up first)'],
      [
        {
          kind: 'run-command',
          command: 'claude',
          args: ['plugin', 'install', 'a@b'],
          description: 'install a',
        },
        'run     claude plugin install a@b (install a)',
      ],
      [
        { kind: 'clone-external', repoUrl: 'git@github.com:a/b.git', destination: '/h/repos/b' },
        'clone   git@github.com:a/b.git into ~/repos/b',
      ],
      [{ kind: 'note', message: 'heads up' }, 'note    heads up'],
    ];
    for (const [action, text] of cases) {
      expect(describeAction(action, home)).toBe(text);
    }
  });

  it('quotes JSON arguments and cuts long ones', () => {
    const json = JSON.stringify({ command: 'npx', env: { TOKEN: '${secret:T}' } });
    const line = describeAction(
      {
        kind: 'run-command',
        command: 'claude',
        args: ['mcp', 'add-json', 'gh', json, 'x'.repeat(100), 'a b'],
        description: 'd',
      },
      home,
    );
    expect(line).toBe(`run     claude mcp add-json gh '${json}' ${'x'.repeat(77)}... 'a b' (d)`);
  });
});

describe('summarizePlan', () => {
  it('says when there is nothing to do', () => {
    expect(summarizePlan([], home)).toBe(
      'Nothing to do. Everything already matches the config repo.\n',
    );
  });

  it('counts changes, not notes', () => {
    const one = summarizePlan(
      [
        { kind: 'mkdir', path: '/h/a' },
        { kind: 'note', message: 'n' },
      ],
      home,
    );
    expect(one).toBe('1 change planned:\n  mkdir   ~/a\n  note    n\n');
    const two = summarizePlan(
      [
        { kind: 'mkdir', path: '/h/a' },
        { kind: 'mkdir', path: '/h/b' },
      ],
      home,
    );
    expect(two).toBe('2 changes planned:\n  mkdir   ~/a\n  mkdir   ~/b\n');
    expect(summarizePlan([{ kind: 'note', message: 'n' }], home)).toBe(
      '0 changes planned:\n  note    n\n',
    );
  });
});
