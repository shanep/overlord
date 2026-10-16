import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AutoApproveRule } from '../../shared/protocol.js';

import {
  alwaysAllowRule,
  evaluateRules,
  findMatchingRule,
  isCompoundCommand,
  literalPattern,
  ruleMatches,
  ruleSubject,
  SEND_MESSAGE_TOOL,
  toolPatternMatches,
} from './rules.js';

function rule(overrides: Partial<AutoApproveRule> & Pick<AutoApproveRule, 'id'>): AutoApproveRule {
  return {
    enabled: true,
    behavior: 'allow',
    tool: '*',
    pattern: null,
    description: '',
    ...overrides,
  };
}

function expectedOutcome(
  matching: readonly AutoApproveRule[],
): { behavior: 'allow' | 'deny'; ruleId: string } | null {
  const winner = matching.find((candidate) => candidate.behavior === 'deny') ?? matching[0];
  return winner === undefined ? null : { behavior: winner.behavior, ruleId: winner.id };
}

describe('ruleSubject', () => {
  it('uses the command for Bash and PowerShell', () => {
    expect(ruleSubject('Bash', { command: 'ls -la', description: 'list' })).toStrictEqual({
      kind: 'command',
      value: 'ls -la',
    });
    expect(ruleSubject('PowerShell', { command: 'dir' })).toStrictEqual({
      kind: 'command',
      value: 'dir',
    });
  });

  it('uses the command over a path for shells only', () => {
    expect(ruleSubject('Bash', { command: 'cat /a', file_path: '/a' })).toStrictEqual({
      kind: 'command',
      value: 'cat /a',
    });
    expect(ruleSubject('PowerShell', { command: 'type a', path: '/a' })).toStrictEqual({
      kind: 'command',
      value: 'type a',
    });
    expect(ruleSubject('bash', { command: 'x', path: '/a' })).toStrictEqual({
      kind: 'path',
      value: '/a',
    });
  });

  it('uses file_path, then path, then notebook_path for file tools', () => {
    expect(ruleSubject('Write', { file_path: '/a', path: '/b' })).toStrictEqual({
      kind: 'path',
      value: '/a',
    });
    expect(ruleSubject('Grep', { path: '/b', notebook_path: '/c' })).toStrictEqual({
      kind: 'path',
      value: '/b',
    });
    expect(ruleSubject('NotebookEdit', { notebook_path: '/c' })).toStrictEqual({
      kind: 'path',
      value: '/c',
    });
  });

  it('prefers a path over a command for tools that are not shells', () => {
    expect(ruleSubject('mcp__x__run', { command: 'go', path: '/p' })).toStrictEqual({
      kind: 'path',
      value: '/p',
    });
    expect(ruleSubject('mcp__x__run', { command: 'go' })).toStrictEqual({
      kind: 'command',
      value: 'go',
    });
  });

  it('is null when the input has nothing to match', () => {
    expect(ruleSubject('Bash', {})).toBeNull();
    expect(ruleSubject('Bash', { command: 5 })).toBeNull();
    expect(ruleSubject('Read', { file_path: ['x'] })).toBeNull();
    expect(ruleSubject('Read', null)).toBeNull();
    expect(ruleSubject('Read', 'file')).toBeNull();
  });
});

describe('isCompoundCommand', () => {
  it.each([
    'a; b',
    'a && b',
    'a || b',
    'a | b',
    'echo `id`',
    'echo $(id)',
    'cat > f',
    'cat < f',
    'a\nb',
    'a\rb',
    'sleep 1 &',
  ])('flags %j', (command) => {
    expect(isCompoundCommand(command)).toBe(true);
  });

  it.each(['git status', 'npm run lint -- --fix', 'echo $HOME', 'ls "a b"'])(
    'allows %j',
    (command) => {
      expect(isCompoundCommand(command)).toBe(false);
    },
  );
});

function exactCommandRule(text: string): AutoApproveRule {
  return rule({ id: 'exact', tool: 'Bash', pattern: literalPattern(text) });
}

// Every character a command might hold except a backslash, which literalPattern refuses.
const COMMAND_CHARS = ['a', 'b', ' ', '/', '.', '-', '_', '*', '?', '[', ']', '{', '}', '(', ')'];
const MORE_COMMAND_CHARS = ['!', '+', '@', '^', '$', ',', '"', "'", '#', '~', '%', '=', ':', '0'];

describe('literalPattern', () => {
  it('matches its text exactly, glob and quote characters included', () => {
    const commands = [
      'git status',
      'echo "a (b)" [x] *.ts !foo',
      "grep -E 'a+b{2}' src/**/*.ts",
      'echo $HOME ~/a?b @(x) +(y) a]b',
    ];
    for (const command of commands) {
      const pattern = exactCommandRule(command);
      expect(ruleMatches(pattern, 'Bash', { command })).toBe(true);
      expect(ruleMatches(pattern, 'Bash', { command: `${command}x` })).toBe(false);
      expect(ruleMatches(pattern, 'Bash', { command: `x${command}` })).toBe(false);
    }
  });

  it('matches exactly what it was made from (property)', () => {
    const text = fc.string({
      unit: fc.constantFrom(...COMMAND_CHARS, ...MORE_COMMAND_CHARS),
      minLength: 1,
    });
    fc.assert(
      fc.property(text, fc.constantFrom('a', '/', '*'), (raw, extra) => {
        const command = raw.trim();
        fc.pre(command !== '' && !isCompoundCommand(command));
        const pattern = exactCommandRule(command);
        expect(ruleMatches(pattern, 'Bash', { command })).toBe(true);
        expect(ruleMatches(pattern, 'Bash', { command: `${command}${extra}` })).toBe(false);
      }),
    );
  });
});

describe('alwaysAllowRule', () => {
  it('allows the exact command for a shell tool', () => {
    const made = alwaysAllowRule('Bash', { command: '  git log --format="%h (%s)"  ' }, 'r1');
    expect(made).toStrictEqual({
      id: 'r1',
      enabled: true,
      behavior: 'allow',
      tool: 'Bash',
      pattern: literalPattern('git log --format="%h (%s)"'),
      description: 'Added by Always allow',
    });
    if (made === null) {
      return;
    }
    expect(ruleMatches(made, 'Bash', { command: 'git log --format="%h (%s)"' })).toBe(true);
    expect(ruleMatches(made, 'Bash', { command: 'git log --format="%h (%s)" -p' })).toBe(false);
    expect(ruleMatches(made, 'PowerShell', { command: 'git log --format="%h (%s)"' })).toBe(false);
  });

  it('allows the whole tool when there is no command', () => {
    expect(alwaysAllowRule('Edit', { file_path: '/a.ts' }, 'r2')).toMatchObject({
      tool: 'Edit',
      pattern: null,
    });
    expect(alwaysAllowRule('mcp__github__create_issue', {}, 'r3')).toMatchObject({
      tool: 'mcp__github__create_issue',
      pattern: null,
    });
  });

  it('gives no rule for a compound command, since no allow rule could match it', () => {
    expect(alwaysAllowRule('Bash', { command: 'ls && rm -rf ~' }, 'r4')).toBeNull();
    expect(alwaysAllowRule('Bash', { command: 'ls\n' }, 'r5')).toBeNull();
  });

  it('gives no rule for a command with a backslash, since no pattern matches it exactly', () => {
    expect(alwaysAllowRule('Bash', { command: String.raw`printf "a\n"` }, 'r6')).toBeNull();
  });
});

describe('ruleMatches', () => {
  it('ignores disabled rules', () => {
    expect(ruleMatches(rule({ id: 'r', enabled: false }), 'Bash', { command: 'ls' })).toBe(false);
    expect(ruleMatches(rule({ id: 'r' }), 'Bash', { command: 'ls' })).toBe(true);
  });

  it('matches tool names with globs and exactly otherwise', () => {
    const mcp = rule({ id: 'r', tool: 'mcp__github__*' });
    expect(ruleMatches(mcp, 'mcp__github__create_issue', {})).toBe(true);
    expect(ruleMatches(mcp, 'mcp__gitlab__create_issue', {})).toBe(false);
    const read = rule({ id: 'r', tool: 'Read' });
    expect(ruleMatches(read, 'Read', {})).toBe(true);
    expect(ruleMatches(read, 'read', {})).toBe(false);
    expect(ruleMatches(read, 'ReadAll', {})).toBe(false);
  });

  it('never matches an empty tool pattern', () => {
    expect(ruleMatches(rule({ id: 'r', tool: '' }), 'Bash', {})).toBe(false);
  });

  it('matches command patterns with stars that cross slashes', () => {
    const npm = rule({ id: 'r', tool: 'Bash', pattern: 'npm run *' });
    expect(ruleMatches(npm, 'Bash', { command: 'npm run lint' })).toBe(true);
    expect(ruleMatches(npm, 'Bash', { command: '  npm run test/unit  ' })).toBe(true);
    expect(ruleMatches(npm, 'Bash', { command: 'npm install' })).toBe(false);
    expect(ruleMatches(npm, 'Bash', {})).toBe(false);
  });

  it('never lets an allow rule match a compound command', () => {
    const git = rule({ id: 'r', tool: 'Bash', pattern: 'git status*' });
    expect(ruleMatches(git, 'Bash', { command: 'git status' })).toBe(true);
    expect(ruleMatches(git, 'Bash', { command: 'git status && rm -rf ~' })).toBe(false);
    const all = rule({ id: 'r', tool: 'Bash', pattern: '*' });
    expect(ruleMatches(all, 'Bash', { command: 'a; b' })).toBe(false);
    expect(ruleMatches(rule({ id: 'r', tool: 'Bash' }), 'Bash', { command: 'a; b' })).toBe(true);
  });

  it('lets a deny rule match a compound command', () => {
    const deny = rule({ id: 'd', behavior: 'deny', tool: 'Bash', pattern: '*rm -rf*' });
    expect(ruleMatches(deny, 'Bash', { command: 'git status && rm -rf ~' })).toBe(true);
  });

  it('matches path patterns with normal glob rules', () => {
    const source = rule({ id: 'r', tool: 'Edit', pattern: '/repo/src/**/*.ts' });
    expect(ruleMatches(source, 'Edit', { file_path: '/repo/src/a/b.ts' })).toBe(true);
    expect(ruleMatches(source, 'Edit', { file_path: '/repo/src/.hidden/b.ts' })).toBe(true);
    expect(ruleMatches(source, 'Edit', { file_path: '/repo/test/b.ts' })).toBe(false);
    const shallow = rule({ id: 'r', tool: 'Edit', pattern: '/repo/*' });
    expect(ruleMatches(shallow, 'Edit', { file_path: '/repo/a/b' })).toBe(false);
    expect(ruleMatches(shallow, 'Edit', { file_path: '/repo/a' })).toBe(true);
  });

  it('treats a bad pattern as no match', () => {
    expect(ruleMatches(rule({ id: 'r', pattern: '' }), 'Read', { file_path: '/a' })).toBe(false);
  });

  it('reuses compiled patterns', () => {
    const cached = rule({ id: 'r', tool: 'Read', pattern: '/x/**' });
    expect(ruleMatches(cached, 'Read', { file_path: '/x/1' })).toBe(true);
    expect(ruleMatches(cached, 'Read', { file_path: '/x/2' })).toBe(true);
    expect(ruleMatches(cached, 'Read', { file_path: '/y/2' })).toBe(false);
  });

  it('keeps command and path compilations of one pattern apart', () => {
    const commandRule = rule({ id: 'c', tool: 'Bash', pattern: 'a*' });
    const pathRule = rule({ id: 'p', tool: 'Read', pattern: 'a*' });
    expect(ruleMatches(commandRule, 'Bash', { command: 'a/b' })).toBe(true);
    expect(ruleMatches(pathRule, 'Read', { file_path: 'a/b' })).toBe(false);
    expect(ruleMatches(commandRule, 'Bash', { command: 'a/b' })).toBe(true);
  });
});

describe('evaluateRules', () => {
  it('returns null when nothing matches', () => {
    expect(evaluateRules([], 'Bash', { command: 'ls' })).toBeNull();
    expect(evaluateRules([rule({ id: 'a', tool: 'Read' })], 'Bash', {})).toBeNull();
  });

  it('returns the first matching allow rule', () => {
    const rules = [
      rule({ id: 'skip', tool: 'Read' }),
      rule({ id: 'first', tool: 'Bash' }),
      rule({ id: 'second', tool: 'Bash' }),
    ];
    expect(evaluateRules(rules, 'Bash', { command: 'ls' })).toStrictEqual({
      behavior: 'allow',
      ruleId: 'first',
    });
  });

  it('lets a later deny rule beat an earlier allow rule', () => {
    const rules = [
      rule({ id: 'allow', tool: 'Bash' }),
      rule({ id: 'deny', tool: 'Bash', behavior: 'deny', pattern: 'rm *' }),
      rule({ id: 'deny2', tool: 'Bash', behavior: 'deny' }),
    ];
    expect(evaluateRules(rules, 'Bash', { command: 'rm x' })).toStrictEqual({
      behavior: 'deny',
      ruleId: 'deny',
    });
    expect(evaluateRules(rules, 'Bash', { command: 'ls' })).toStrictEqual({
      behavior: 'deny',
      ruleId: 'deny2',
    });
    expect(findMatchingRule(rules, 'Bash', { command: 'rm x' })).toBe(rules[1]);
  });

  it('ignores a disabled deny rule', () => {
    const rules = [rule({ id: 'deny', behavior: 'deny', enabled: false }), rule({ id: 'allow' })];
    expect(evaluateRules(rules, 'Read', {})).toStrictEqual({ behavior: 'allow', ruleId: 'allow' });
  });

  const tools = fc.constantFrom('Bash', 'Read', 'Edit', 'mcp__github__x', '*', 'mcp__*');
  const patterns = fc.option(fc.constantFrom('*', 'ls*', '/a/**', 'git *', '**'), { nil: null });
  const ruleArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 6 }),
    enabled: fc.boolean(),
    behavior: fc.constantFrom<'allow' | 'deny'>('allow', 'deny'),
    tool: tools,
    pattern: patterns,
    description: fc.constant(''),
  });
  const inputArb = fc.oneof(
    fc.record({ command: fc.constantFrom('ls -la', 'git push', 'ls; rm x', 'npm test') }),
    fc.record({ file_path: fc.constantFrom('/a/b.ts', '/c/d', '/a/.x') }),
    fc.constant({}),
  );
  const toolNameArb = fc.constantFrom('Bash', 'Read', 'Edit', 'mcp__github__x');

  it('always prefers a matching deny rule over any allow rule (property)', () => {
    fc.assert(
      fc.property(
        fc.array(ruleArb, { maxLength: 8 }),
        toolNameArb,
        inputArb,
        (rules, tool, input) => {
          const matching = rules.filter((candidate) => ruleMatches(candidate, tool, input));
          expect(evaluateRules(rules, tool, input)).toStrictEqual(expectedOutcome(matching));
        },
      ),
    );
  });

  it('gives the same answer in any rule order when a deny matches (property)', () => {
    fc.assert(
      fc.property(
        fc.array(ruleArb, { maxLength: 8 }),
        toolNameArb,
        inputArb,
        (rules, tool, input) => {
          const forward = evaluateRules(rules, tool, input);
          const backward = evaluateRules(rules.toReversed(), tool, input);
          expect(forward?.behavior).toBe(backward?.behavior);
        },
      ),
    );
  });

  it('never returns a disabled rule (property)', () => {
    fc.assert(
      fc.property(
        fc.array(ruleArb, { maxLength: 8 }),
        toolNameArb,
        inputArb,
        (rules, tool, input) => {
          const found = findMatchingRule(rules, tool, input);
          expect(found === null || found.enabled).toBe(true);
        },
      ),
    );
  });
});

describe('SendMessage rules', () => {
  const message = { to: 'uds:/tmp/cc-socks/42.sock', message: 'hello', summary: 'hi' };

  it('names the tool', () => {
    expect(SEND_MESSAGE_TOOL).toBe('SendMessage');
  });

  it('matches the recipient, not a command or path', () => {
    expect(ruleSubject('SendMessage', message)).toStrictEqual({
      kind: 'recipient',
      value: 'uds:/tmp/cc-socks/42.sock',
    });
    expect(ruleSubject('SendMessage', { message: 'no recipient', command: 'ls' })).toBeNull();
    expect(ruleSubject('SendMessage', { to: 7 })).toBeNull();
  });

  it('lets a star cross the slashes in a socket address', () => {
    const deny = rule({ id: 'd', behavior: 'deny', tool: 'SendMessage', pattern: 'uds:*' });
    expect(ruleMatches(deny, 'SendMessage', message)).toBe(true);
    expect(ruleMatches(deny, 'SendMessage', { to: 'main' })).toBe(false);
    expect(ruleMatches(deny, 'SendMessage', { to: ' uds:/x' })).toBe(false);
    const exact = rule({ id: 'e', behavior: 'deny', tool: 'SendMessage', pattern: 'wt-apps-*' });
    expect(ruleMatches(exact, 'SendMessage', { to: 'wt-apps-d3' })).toBe(true);
    expect(ruleMatches(exact, 'SendMessage', { to: 'main' })).toBe(false);
  });

  it('keeps file paths on the strict matcher', () => {
    const paths = rule({ id: 'p', tool: 'Read', pattern: 'src/*' });
    expect(ruleMatches(paths, 'Read', { file_path: 'src/a/b.ts' })).toBe(false);
    expect(ruleMatches(paths, 'Read', { file_path: 'src/b.ts' })).toBe(true);
  });

  it('checks a tool pattern whether or not the rule is enabled', () => {
    expect(toolPatternMatches('SendMessage', 'SendMessage')).toBe(true);
    expect(toolPatternMatches('Send*', 'SendMessage')).toBe(true);
    expect(toolPatternMatches('*', 'SendMessage')).toBe(true);
    expect(toolPatternMatches('Bash', 'SendMessage')).toBe(false);
  });
});
