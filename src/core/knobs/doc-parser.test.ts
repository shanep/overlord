// cspell:ignore effortlevel forceloginmethod claudeai autocompact
// The module under test is doc-parser.ts, a name PLAN.md fixes, hence the disable below.
// eslint-disable-next-line unicorn/prevent-abbreviations -- see the note above
import { describe, expect, it } from 'vitest';

import type { KnobDefinition } from '../../shared/model.js';

import {
  buildCatalog,
  DOCS_BASE,
  envTypeInfo,
  extractAllowedList,
  finalizeCatalog,
  flagValueType,
  parseCliPage,
  parseDefault,
  parseEnvDefault,
  parseEnvVariablesPage,
  parseSettingSections,
  parseSettingsPage,
  parseSettingType,
} from './doc-parser.js';

const EM_DASH = String.fromCodePoint(0x20_14);

const SETTINGS_REFERENCE = [
  '# All settings',
  '',
  '## Settings index',
  '',
  '| Key | Description | Topic | Scope |',
  '| :- | :- | :- | :- |',
  '| [`model`](#model) | Change the [model](/docs/en/model-config) | Model and responses | Any file |',
  '| [`effortLevel`](#effortlevel) | Set effort | Model and responses | Any file |',
  '| [`forceLoginMethod`](#forceloginmethod) | Pick a login | Authentication and providers | Managed |',
  '| [`permissions.allow`](#permissions-allow) | Approve tools | Permission settings | Any file |',
  `| \`noSection\` | Fast ${EM_DASH} cheap | Git and attribution | User |`,
  '| plain words | no key | Tools | Any file |',
  '',
  '| Key | Value Claude Code honors | Notes |',
  '| :- | :- | :- |',
  '| [`ignored`](#ignored) | x | y |',
  '',
  '## Model and responses',
  '',
  '### `model`',
  '',
  '* **Scope**: [`Any file`](#scopes)',
  '* **Type**: string, a model alias or full model ID',
  '* **Default**: unset',
  '',
  '### `effortLevel`',
  '',
  '* **Type**: string, one of:',
  '  * `"low"`: the least',
  '  * `"high"`: the most',
  '  * `"high"`: again',
  '* **Default**: `"high"`',
  '',
  '#### Fields for `effortLevel`',
  '',
  'Text under a sub-heading still belongs to the key.',
  '',
  '### `forceLoginMethod`',
  '',
  '* **Type**: string, one of `"claudeai"` or `"console"`',
  '* **Default**: `"claudeai"`',
  '',
  '## Permission settings',
  '',
  '* **Type**: Boolean',
  '',
  '### `permissions.allow`',
  '',
  '* **Type**: array of permission rule strings',
].join('\n');

const ENV_VARS = [
  '## Set variables in settings files',
  '',
  '| File | Scope |',
  '| :- | :- |',
  '| `~/.claude/settings.json` | user |',
  '',
  '## Variables',
  '',
  '| Variable | Purpose |',
  '| :- | :- |',
  '| `API_TIMEOUT_MS` | Timeout for API requests in milliseconds (default: 600000) |',
  '| `CLAUDE_CODE_DISABLE_THING` | Set to `1` to turn the thing off |',
  '| `ANTHROPIC_BEDROCK_SERVICE_TIER` | Service tier (`default`, `flex`, or `priority`) |',
  '| `~/.claude/settings.json` | not a variable |',
  '| plain | no code |',
  '| `FIRST`, `SECOND` | Two names, the first wins. Defaults to `~/x` |',
].join('\n');

const CLI_REFERENCE = [
  '## CLI commands',
  '',
  '| Command | Description | Example |',
  '| :- | :- | :- |',
  '| `claude` | Start | `claude` |',
  '',
  '## CLI flags',
  '',
  '| Flag | Description | Example |',
  '| :- | :- | :- |',
  '| `--continue`, `-c` | Continue the last conversation | `claude --continue` |',
  '| `--max-turns` | Limit turns | `claude -p --max-turns 3 "query"` |',
  String.raw`| \`--autocompact <auto\|tokens>\` | Set the window | \`claude --autocompact 500k\` |`,
  '| `--output-format` | Output format (options: `text`, `json`) | `claude -p "query" --output-format json` |',
  '| `--bare` | One of `a` or `b` is ignored for booleans | `claude --bare -p "query"` |',
  '| `claude` | not a flag | `claude` |',
  '| no code | x | y |',
  '',
  '### System prompt flags',
  '',
  '| Flag | Behavior | Example |',
  '| :- | :- | :- |',
  '| `--system-prompt` | Replaces the prompt | `claude --system-prompt "x"` |',
  '| `--continue` | Duplicate row | `claude --continue` |',
].join('\n');

function knob(partial: Partial<KnobDefinition> & Pick<KnobDefinition, 'key'>): KnobDefinition {
  return {
    kind: 'setting',
    area: 'other',
    valueType: 'string',
    defaultValue: null,
    allowed: [],
    description: '',
    docUrl: `${DOCS_BASE}/x`,
    appliesAt: 'next-launch',
    managedOnly: false,
    ...partial,
  };
}

describe('parseSettingType', () => {
  it.each([
    ['Boolean', 'boolean'],
    ['  Boolean; only `true` counts', 'boolean'],
    ['number, a local TCP port', 'number'],
    ['integer from 1 to 9', 'number'],
    ['array of strings', 'string[]'],
    ['array of permission rule strings', 'string[]'],
    ['array of objects, each with a key', 'json'],
    ['object with the sub-keys below', 'json'],
    ['string', 'string'],
    ['string, a shell command line', 'string'],
    ['String, an absolute path', 'string'],
  ])('reads %s as %s', (typeLine, valueType) => {
    expect(parseSettingType(typeLine, [])).toStrictEqual({ valueType, allowed: [] });
  });

  it('reads inline and nested enum values, without duplicates or quotes', () => {
    expect(parseSettingType('string, one of `"a"`, `"b"`, or `"a"`', [])).toStrictEqual({
      valueType: 'enum',
      allowed: ['a', 'b'],
    });
    expect(
      parseSettingType('String, One of:', [
        '  * `"low"`: least',
        '  * `"high"`: most',
        '  * `"high"`: again',
        '  * `unquoted`: also counts',
        '  * plain bullet',
        'not nested `"x"`',
      ]),
    ).toStrictEqual({ valueType: 'enum', allowed: ['low', 'high', 'unquoted'] });
  });

  it('prefers inline values over nested ones', () => {
    expect(parseSettingType('string, one of `"a"`', ['  * `"b"`: b'])).toStrictEqual({
      valueType: 'enum',
      allowed: ['a'],
    });
  });

  it('treats an open-ended "one of ... such as" list and an empty list as a string', () => {
    expect(
      parseSettingType('string, one of the aliases `"opus"`, or an ID such as `"x"`', []),
    ).toStrictEqual({ valueType: 'string', allowed: [] });
    expect(parseSettingType('string, one of:', ['  * text only'])).toStrictEqual({
      valueType: 'string',
      allowed: [],
    });
    expect(parseSettingType('string, one of `x`', [])).toStrictEqual({
      valueType: 'string',
      allowed: [],
    });
  });

  it('reads "the string" as a one-value enum', () => {
    expect(parseSettingType('the string `"disable"`', [])).toStrictEqual({
      valueType: 'enum',
      allowed: ['disable'],
    });
  });
});

describe('parseDefault', () => {
  it('takes a leading code span and leaves prose as null', () => {
    expect(parseDefault('`false`')).toBe('false');
    expect(parseDefault('  `"auto"`, unless set')).toBe('auto');
    expect(parseDefault('`5000` ms')).toBe('5000');
    expect(parseDefault('``')).toBe('');
    expect(parseDefault('unset, so `x` applies')).toBeNull();
    expect(parseDefault('')).toBeNull();
  });
});

describe('extractAllowedList', () => {
  it.each([
    ['Prefix (`us`, `eu`, or `global`) first', ['us', 'eu', 'global']],
    ['one of `a` or `b`', ['a', 'b']],
    ['Accepts `x`, `y`. Then `z` too', ['x', 'y']],
    ['(options: `text`, `json`)', ['text', 'json']],
    ['ONE OF `"a"`,  or\n`"b"`', ['a', 'b']],
  ])('reads %s', (text, allowed) => {
    expect(extractAllowedList(text)).toStrictEqual(allowed);
  });

  it.each([
    'A session ID (`session_...` or `cse_...`)',
    'Only (`one`) value',
    'No intro `a`, `b`',
    'one of the values',
    'one of `a` and `b`',
  ])('finds no list in %s', (text) => {
    expect(extractAllowedList(text)).toStrictEqual([]);
  });
});

describe('parseSettingSections', () => {
  it('collects the Type, nested bullets and Default of each key', () => {
    const sections = parseSettingSections(SETTINGS_REFERENCE);
    expect([...sections.keys()]).toStrictEqual([
      'model',
      'effortLevel',
      'forceLoginMethod',
      'permissions.allow',
    ]);
    expect(sections.get('model')).toStrictEqual({
      typeLine: ' string, a model alias or full model ID',
      nested: [],
      defaultText: ' unset',
    });
    expect(sections.get('effortLevel')).toStrictEqual({
      typeLine: ' string, one of:',
      nested: ['  * `"low"`: the least', '  * `"high"`: the most', '  * `"high"`: again'],
      defaultText: ' `"high"`',
    });
    expect(sections.get('permissions.allow')).toStrictEqual({
      typeLine: ' array of permission rule strings',
      nested: [],
      defaultText: null,
    });
  });

  it('stops a section at the next level 1 to 3 heading', () => {
    const sections = parseSettingSections(
      '### `a`\n# Top\n* **Type**: Boolean\n### `b`\n## Next\n* **Default**: `1`',
    );
    expect(sections.get('a')).toStrictEqual({ typeLine: null, nested: [], defaultText: null });
    expect(sections.get('b')).toStrictEqual({ typeLine: null, nested: [], defaultText: null });
  });

  it('only collects nested bullets right under the Type bullet', () => {
    const sections = parseSettingSections(
      '### `a`\n* **Scope**: x\n  * `"no"`\n* **Type**: string, one of:\n  * `"yes"`\nbreak\n  * `"late"`',
    );
    expect(sections.get('a')?.nested).toStrictEqual(['  * `"yes"`']);
  });
});

describe('parseSettingsPage', () => {
  it('builds one knob per index row that names a key', () => {
    const knobs = parseSettingsPage(SETTINGS_REFERENCE, 'settings-reference');
    expect(knobs.map((item) => item.key)).toStrictEqual([
      'model',
      'effortLevel',
      'forceLoginMethod',
      'permissions.allow',
      'noSection',
    ]);
    expect(knobs[0]).toStrictEqual({
      key: 'model',
      kind: 'setting',
      area: 'model',
      valueType: 'string',
      defaultValue: null,
      allowed: [],
      description: 'Change the model',
      docUrl: 'https://code.claude.com/docs/en/settings-reference#model',
      appliesAt: 'live',
      managedOnly: false,
    });
    expect(knobs[1]).toMatchObject({
      key: 'effortLevel',
      area: 'thinking',
      valueType: 'enum',
      allowed: ['low', 'high'],
      defaultValue: 'high',
      appliesAt: 'next-launch',
    });
    expect(knobs[2]).toMatchObject({
      key: 'forceLoginMethod',
      area: 'policy',
      valueType: 'enum',
      allowed: ['claudeai', 'console'],
      defaultValue: 'claudeai',
      managedOnly: true,
    });
    expect(knobs[3]).toMatchObject({
      key: 'permissions.allow',
      area: 'permissions',
      valueType: 'string[]',
      defaultValue: null,
      docUrl: 'https://code.claude.com/docs/en/settings-reference#permissions-allow',
    });
    expect(knobs[4]).toStrictEqual({
      key: 'noSection',
      kind: 'setting',
      area: 'other',
      valueType: 'json',
      defaultValue: null,
      allowed: [],
      description: 'Fast, cheap',
      docUrl: 'https://code.claude.com/docs/en/settings-reference#nosection',
      appliesAt: 'next-launch',
      managedOnly: false,
    });
  });

  it('tolerates short rows', () => {
    const knobs = parseSettingsPage('| Key | Description |\n| - | - |\n| `solo` |', 'settings');
    expect(knobs).toStrictEqual([
      knob({ key: 'solo', valueType: 'json', docUrl: `${DOCS_BASE}/settings#solo` }),
    ]);
  });
});

describe('parseEnvDefault', () => {
  it.each([
    ['Timeout (default: 5000).', '5000'],
    ['Defaults to `~/.claude/x`', '~/.claude/x'],
    ['Default is `bundled,system`', 'bundled,system'],
    ['Budget, default 64_000', null],
    ['Defaults to 64_000 tokens', '64_000'],
    ['Default: `600000`', '600000'],
    ['default: `x`, later default: 5', 'x'],
    ['Defaults to your hostname', null],
    ['No default here', null],
  ])('reads %s as %s', (text, expected) => {
    expect(parseEnvDefault(text)).toBe(expected);
  });
});

describe('envTypeInfo', () => {
  it.each([
    ['ANY', 'Comma-separated list of names', 'string[]'],
    ['CLAUDE_CODE_DISABLE_X', 'Turns X off', 'boolean'],
    ['DISABLE_TELEMETRY', 'Opt out', 'boolean'],
    ['CLAUDE_CODE_ENABLE_X', 'Turns X on', 'boolean'],
    ['CLAUDE_CODE_SKIP_X', 'Skips X', 'boolean'],
    ['CLAUDE_CODE_USE_X', 'Uses X', 'boolean'],
    ['FORCE_X', 'Forces X', 'boolean'],
    ['PLAIN', 'Set to `1` to turn it on', 'boolean'],
    ['PLAIN', 'set it to true for more', 'boolean'],
    ['PLAIN', 'Set to 10 for ten', 'string'],
    ['PLAIN', 'How many (default: 20)', 'number'],
    ['PLAIN', 'Where (default: `/tmp`)', 'string'],
    ['API_TIMEOUT_MS', 'Timeout', 'number'],
    ['MAX_OUTPUT_TOKENS', 'Cap', 'number'],
    ['PLAIN', 'Wait in milliseconds', 'number'],
    ['PLAIN', 'A name', 'string'],
  ])('reads %s (%s) as %s', (key, description, valueType) => {
    expect(envTypeInfo(key, description)).toStrictEqual({ valueType, allowed: [] });
  });

  it('reads an allowed list as an enum', () => {
    expect(envTypeInfo('TIER', 'Tier (`a`, `b`, or `c`)')).toStrictEqual({
      valueType: 'enum',
      allowed: ['a', 'b', 'c'],
    });
  });
});

describe('parseEnvVariablesPage', () => {
  it('reads every row of the Variable table that names a variable', () => {
    const knobs = parseEnvVariablesPage(ENV_VARS);
    expect(knobs.map((item) => item.key)).toStrictEqual([
      'API_TIMEOUT_MS',
      'CLAUDE_CODE_DISABLE_THING',
      'ANTHROPIC_BEDROCK_SERVICE_TIER',
      'FIRST',
    ]);
    expect(knobs[0]).toStrictEqual({
      key: 'API_TIMEOUT_MS',
      kind: 'env',
      area: 'network',
      valueType: 'number',
      defaultValue: '600000',
      allowed: [],
      description: 'Timeout for API requests in milliseconds (default: 600000)',
      docUrl: 'https://code.claude.com/docs/en/env-vars#variables',
      appliesAt: 'next-launch',
      managedOnly: false,
    });
    expect(knobs[1]).toMatchObject({
      valueType: 'boolean',
      description: 'Set to 1 to turn the thing off',
    });
    expect(knobs[2]).toMatchObject({
      area: 'auth',
      valueType: 'enum',
      allowed: ['default', 'flex', 'priority'],
    });
    expect(knobs[3]).toMatchObject({ defaultValue: '~/x', valueType: 'string' });
  });

  it('tolerates short rows', () => {
    expect(parseEnvVariablesPage('| Variable |\n| - |\n| `SOLO` |')).toStrictEqual([
      knob({ key: 'SOLO', kind: 'env', docUrl: `${DOCS_BASE}/env-vars#variables` }),
    ]);
  });
});

describe('flagValueType', () => {
  it.each([
    ['`--debug-file <path>`', ['--debug-file'], '`claude --debug-file`', 'string'],
    ['`--bare`', ['--bare'], '`claude --bare -p "query"`', 'boolean'],
    ['`--init`', ['--init'], '`claude -p --init "query"`', 'boolean'],
    ['`--verbose`', ['--verbose'], '`claude --verbose`', 'boolean'],
    ['`--max-turns`', ['--max-turns'], '`claude -p --max-turns 3 "query"`', 'number'],
    ['`--max-budget-usd`', ['--max-budget-usd'], '`claude --max-budget-usd 5.00`', 'number'],
    ['`--model`', ['--model'], '`claude --model sonnet`', 'string'],
    ['`--debug`', ['--debug'], "`claude --debug='mcp,startup'`", 'string'],
    ['`--x`', ['--x'], '`claude --x=5`', 'number'],
    ['`--y`', ['--y'], '`claude --y= -p`', 'string'],
    ['`--continue`, `-c`', ['--continue', '-c'], '`claude -c`', 'boolean'],
    ['`--tools`', ['--tools'], '`claude --tools "Bash,Edit"`', 'string'],
    ['`--allowedTools`', ['--allowedTools'], '`"Bash(git log *)" "Read"`', 'string'],
    ['`--z`', ['--z'], 'no code at all', 'string'],
  ])('reads %s with example %s', (header, flags, example, expected) => {
    expect(flagValueType(header, flags, example)).toBe(expected);
  });
});

describe('parseCliPage', () => {
  it('reads every Flag table, notes aliases and anchors each table', () => {
    const knobs = parseCliPage(CLI_REFERENCE);
    expect(knobs.map((item) => item.key)).toStrictEqual([
      '--continue',
      '--max-turns',
      '--autocompact',
      '--output-format',
      '--bare',
      '--system-prompt',
      '--continue',
    ]);
    expect(knobs[0]).toStrictEqual({
      key: '--continue',
      kind: 'flag',
      area: 'sessions',
      valueType: 'boolean',
      defaultValue: null,
      allowed: [],
      description: 'Continue the last conversation (alias: -c)',
      docUrl: 'https://code.claude.com/docs/en/cli-reference#cli-flags',
      appliesAt: 'next-launch',
      managedOnly: false,
    });
    expect(knobs[1]).toMatchObject({ valueType: 'number', description: 'Limit turns' });
    expect(knobs[2]).toMatchObject({ valueType: 'string', area: 'context' });
    expect(knobs[3]).toMatchObject({ valueType: 'enum', allowed: ['text', 'json'] });
    expect(knobs[4]).toMatchObject({ valueType: 'boolean', allowed: [] });
    expect(knobs[5]).toMatchObject({
      valueType: 'string',
      docUrl: 'https://code.claude.com/docs/en/cli-reference#system-prompt-flags',
    });
  });

  it('tolerates short rows', () => {
    expect(parseCliPage('| Flag |\n| - |\n| `--solo` |')).toStrictEqual([
      knob({ key: '--solo', kind: 'flag', docUrl: `${DOCS_BASE}/cli-reference#` }),
    ]);
  });
});

describe('finalizeCatalog', () => {
  it('keeps the first of each kind and key and sorts by kind then key', () => {
    const first = knob({ key: 'dup', kind: 'env', description: 'first' });
    const result = finalizeCatalog([
      knob({ key: 'b', kind: 'setting' }),
      knob({ key: 'B', kind: 'env' }),
      first,
      knob({ key: '--z', kind: 'flag' }),
      knob({ key: 'dup', kind: 'env', description: 'second' }),
      knob({ key: 'dup', kind: 'setting' }),
      knob({ key: 'A', kind: 'env' }),
      knob({ key: 'a', kind: 'setting' }),
    ]);
    expect(result.map((item) => `${item.kind}:${item.key}`)).toStrictEqual([
      'env:A',
      'env:B',
      'env:dup',
      'flag:--z',
      'setting:a',
      'setting:b',
      'setting:dup',
    ]);
    expect(result[2]).toBe(first);
  });
});

describe('buildCatalog', () => {
  it('combines the three pages into one sorted catalog', () => {
    const catalog = buildCatalog({
      settingsReference: SETTINGS_REFERENCE,
      settings: '',
      envVariables: ENV_VARS,
      cliReference: CLI_REFERENCE,
    });
    expect(catalog.map((item) => `${item.kind}:${item.key}`)).toStrictEqual([
      'env:ANTHROPIC_BEDROCK_SERVICE_TIER',
      'env:API_TIMEOUT_MS',
      'env:CLAUDE_CODE_DISABLE_THING',
      'env:FIRST',
      'flag:--autocompact',
      'flag:--bare',
      'flag:--continue',
      'flag:--max-turns',
      'flag:--output-format',
      'flag:--system-prompt',
      'setting:effortLevel',
      'setting:forceLoginMethod',
      'setting:model',
      'setting:noSection',
      'setting:permissions.allow',
    ]);
    expect(catalog.find((item) => item.key === 'model')?.docUrl).toBe(
      'https://code.claude.com/docs/en/settings-reference#model',
    );
    expect(catalog.find((item) => item.key === '--continue')?.description).toBe(
      'Continue the last conversation (alias: -c)',
    );
  });

  it('falls back to settings.md when the reference page is missing', () => {
    const catalog = buildCatalog({
      settingsReference: null,
      settings: SETTINGS_REFERENCE,
      envVariables: '',
      cliReference: '',
    });
    expect(catalog).toHaveLength(5);
    expect(catalog.find((item) => item.key === 'model')?.docUrl).toBe(
      'https://code.claude.com/docs/en/settings#model',
    );
  });
});

describe('doc-parser edge cases', () => {
  it('only counts fully quoted code spans as enum values', () => {
    expect(parseSettingType('the string `x"` or `"y`', [])).toStrictEqual({
      valueType: 'enum',
      allowed: [],
    });
    expect(parseSettingType('string, a value like `"x"`', [])).toStrictEqual({
      valueType: 'string',
      allowed: [],
    });
  });

  it('reads the list after the intro, not earlier code spans', () => {
    expect(extractAllowedList('Use `foo` or (`a`, `b`)')).toStrictEqual(['a', 'b']);
    expect(extractAllowedList('(`a...`, `b`)')).toStrictEqual([]);
  });

  it('ignores bullets before the Type bullet and headings that do not start the line', () => {
    const sections = parseSettingSections(
      '### `a`\n  * `"early"`\nsee ### `b` inline\n* **Type**: string, one of:\n  * `"yes"`',
    );
    expect(sections.get('a')).toStrictEqual({
      typeLine: ' string, one of:',
      nested: ['  * `"yes"`'],
      defaultText: null,
    });
  });

  it('treats a section with no Type bullet as json', () => {
    const knobs = parseSettingsPage(
      '| Key | Description |\n| - | - |\n| `k` | d |\n\n### `k`\n* **Default**: `true`',
      'settings',
    );
    expect(knobs[0]).toMatchObject({ valueType: 'json', defaultValue: 'true' });
  });

  it('reads only the Variable and Flag tables', () => {
    expect(
      parseEnvVariablesPage('| Name | Purpose |\n| - | - |\n| `REAL_LOOKING` | x |'),
    ).toStrictEqual([]);
    expect(
      parseCliPage('| Option | Description |\n| - | - |\n| `--real-looking` | x |'),
    ).toStrictEqual([]);
  });

  it.each([
    ['A comma-separated list', 'string'],
    ['Wait (default: `5s`)', 'string'],
    ['Name (default: `v5`)', 'string'],
    ['Count (default: 300)', 'number'],
  ])('reads env description %s as %s', (description, valueType) => {
    expect(envTypeInfo('PLAIN', description).valueType).toBe(valueType);
  });

  it.each([
    ['`claude --x 5k`', 'string'],
    ['`claude --x v5`', 'string'],
    ['`claude --x` `-p`', 'boolean'],
  ])('reads flag example %s as %s', (example, expected) => {
    expect(flagValueType('`--x`', ['--x'], example)).toBe(expected);
  });

  it('lists every alias', () => {
    const [flag] = parseCliPage(
      '| Flag | Description |\n| - | - |\n| `--a`, `-b`, `-c` | Does a |',
    );
    expect(flag?.description).toBe('Does a (alias: -b, -c)');
  });
});
