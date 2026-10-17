import { describe, expect, it } from 'vitest';

import {
  buildCodexCatalog,
  codexDefault,
  codexType,
  configTomlSection,
  parseConfigTables,
  parseEnvTables,
  parseGlobalFlags,
} from './codex-reference.js';

const REFERENCE = `# Configuration Reference

## \`config.toml\`

<ConfigTable
  options={[
    {
      key: "model",
      type: "string",
      description: "Model to use (e.g., \`gpt-6.1-sol\`).",
    },
    {
      key: "sandbox_mode",
      type: "read-only | workspace-write | danger-full-access",
      description:
        'Sandbox policy, see [the guide](https://example.com/x). Defaults to \`"read-only"\`.',
    },
    {
      key: 'permissions.<name>.filesystem.":workspace_roots"',
      type: "table",
      description: "A placeholder key {with braces}.",
    },
    {
      key: "tui.notifications",
      type: "boolean | array<string>",
      description: "Enable notifications (default: \`false\`).",
    },
  ]}
/>

## \`requirements.toml\`

<ConfigTable
  options={[
    {
      key: "allowed_approval_policies",
      type: "array<string>",
      description: "Admins only.",
    },
  ]}
/>
`;

const ENVIRONMENT = `# Environment variables

| Variable            | Used by | Default      | Description                 |
| ------------------- | ------- | ------------ | --------------------------- |
| \`CODEX_HOME\`        | CLI     | \`~/.codex\`   | Sets the root for state.    |

| Variable   | Used by | Description         |
| ---------- | ------- | ------------------- |
| \`RUST_LOG\` | CLI     | Controls log level. |
`;

function island(rows: readonly Readonly<Record<string, string>>[]): string {
  const props = {
    options: [
      1,
      rows.map((row) => [
        0,
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, [0, value]])),
      ]),
    ],
  };
  const encoded = JSON.stringify(props).replaceAll('"', '&quot;');
  return `<astro-island uid="a" component-export="ConfigTable" props="${encoded}"></astro-island>`;
}

const COMMANDS = [
  island([
    { key: 'PROMPT', type: 'string', description: 'The first message.' },
    { key: '--model, -m', type: 'string', description: 'Override the model.' },
    {
      key: '--dangerously-bypass-hook-trust',
      type: 'boolean',
      defaultValue: 'false',
      description: 'Run hooks without trust.',
    },
  ]),
  island([{ key: '--json', type: 'boolean', description: 'An exec flag.' }]),
].join('\n');

describe('parseConfigTables', () => {
  it('reads every object of every table, with single or double quotes', () => {
    const options = parseConfigTables(REFERENCE);
    expect(options.map((option) => option.key)).toStrictEqual([
      'model',
      'sandbox_mode',
      'permissions.<name>.filesystem.":workspace_roots"',
      'tui.notifications',
      'allowed_approval_policies',
    ]);
    expect(options[1]?.description).toContain('Defaults to `"read-only"`');
  });

  it("skips a row with no type instead of taking the next row's", () => {
    const text =
      '{ key: "a", description: "no type" },\n{ key: "b", type: "string", description: "B" }';
    expect(parseConfigTables(text).map((row) => row.key)).toStrictEqual(['b']);
  });

  it('stops at requirements.toml for the config.toml part', () => {
    const keys = parseConfigTables(configTomlSection(REFERENCE)).map((option) => option.key);
    expect(keys).not.toContain('allowed_approval_policies');
  });
});

describe('parseEnvTables', () => {
  it('reads the variable, default and description columns of each table', () => {
    expect(parseEnvTables(ENVIRONMENT)).toStrictEqual([
      {
        key: 'CODEX_HOME',
        type: 'string',
        description: 'Sets the root for state.',
        defaultValue: '~/.codex',
      },
      { key: 'RUST_LOG', type: 'string', description: 'Controls log level.', defaultValue: null },
    ]);
  });
});

describe('parseGlobalFlags', () => {
  it("reads the first flag table's long flags from the island props", () => {
    expect(parseGlobalFlags(COMMANDS).map((flag) => [flag.key, flag.defaultValue])).toStrictEqual([
      ['--model', null],
      ['--dangerously-bypass-hook-trust', 'false'],
    ]);
  });
});

describe('codexType and codexDefault', () => {
  it.each([
    ['boolean', 'boolean', []],
    ['integer (milliseconds)', 'number', []],
    ['string (path)', 'string', []],
    ['array<string>', 'string[]', []],
    ['low | medium | high', 'enum', ['low', 'medium', 'high']],
    ['boolean | array<string>', 'json', []],
    ['boolean | table', 'json', []],
    ['map<string,string>', 'json', []],
  ])('reads %s', (type, valueType, allowed) => {
    expect(codexType(type)).toStrictEqual({ valueType, allowed });
  });

  it('finds a default in the description', () => {
    expect(codexDefault('Cache (default: `"cached"`).')).toBe('cached');
    expect(codexDefault('Defaults to `5`.')).toBe('5');
    expect(codexDefault('No default here.')).toBeNull();
  });
});

describe('buildCodexCatalog', () => {
  it('makes knobs of settings, env vars and flags, and leaves placeholder keys out', () => {
    const catalog = buildCodexCatalog({
      configReference: REFERENCE,
      environment: ENVIRONMENT,
      commandsHtml: COMMANDS,
    });
    expect(catalog.map((knob) => `${knob.kind} ${knob.key}`)).toStrictEqual([
      'setting model',
      'setting sandbox_mode',
      'setting tui.notifications',
      'env CODEX_HOME',
      'env RUST_LOG',
      'flag --model',
      'flag --dangerously-bypass-hook-trust',
    ]);
    expect(catalog[1]).toStrictEqual({
      key: 'sandbox_mode',
      kind: 'setting',
      area: 'bash',
      valueType: 'enum',
      defaultValue: 'read-only',
      allowed: ['read-only', 'workspace-write', 'danger-full-access'],
      description: 'Sandbox policy, see the guide. Defaults to `"read-only"`.',
      docUrl: 'https://learn.chatgpt.com/docs/config-file/config-reference',
      appliesAt: 'next-launch',
      managedOnly: false,
    });
    expect(catalog.find((knob) => knob.key === '--dangerously-bypass-hook-trust')).toMatchObject({
      valueType: 'boolean',
      area: 'permissions',
    });
  });
});
