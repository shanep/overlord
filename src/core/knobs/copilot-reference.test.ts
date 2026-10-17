// cspell:words copilotsettingsjson githubcopilotsettingsjson
import { describe, expect, it } from 'vitest';

import {
  buildCopilotCatalog,
  COPILOT_COMMAND_DOCS,
  COPILOT_CONFIG_DOCS,
  copilotDefault,
  copilotSettingType,
  parseCopilotFlags,
} from './copilot-reference.js';

// Trimmed copies of the tables on the two GitHub Docs pages.
const CONFIG_DIR = `
### User settings (\`~/.copilot/settings.json\`)

| Key | Type | Default | Description | |
| --- | --- | --- | --- | --- |
| \`askUser\` | \`boolean\` | \`true\` | Allow the agent to ask clarifying questions. | |
| \`banner\` | \`"always"\` \\| \`"once"\` \\| \`"never"\` | \`"once"\` | Animated banner frequency. | |
| \`model\` | \`string\` | varies | AI model to use. | |
| \`allowedUrls\` | \`string[]\` | \`[]\` | URLs or domains allowed without prompting. | |
| \`hooks\` | \`object\` | unset | Inline hook definitions. | |
| \`subagents.agents["rubber-duck"].autoInvoke\` | \`boolean\` | \`false\` | Not a plain path. | |

### Repository settings (\`.github/copilot/settings.json\`)

| Key | Type | Merge behavior | Description |
| --- | --- | --- | --- |
| \`contextTier\` | \`"default"\` \\| \`"long_context"\` | Replaced | Pin the default context tier. |
| \`model\` | \`string\` | Replaced | Pin the default model for this repo. |

### Supported keys

| Key | Description |
| --- | --- |
| \`notASetting\` | MDM only. |
`;

const COMMANDS = `
## Command-line options

| Option | Purpose |
| --- | --- |
| \`--allow-all\` | Enable all permissions. |
| \`--effort=LEVEL\`, \`--reasoning-effort=LEVEL\` | Set the reasoning effort level (\`low\`, \`medium\`, or \`high\`). |
| \`-r\`, \`--resume[=VALUE]\` | Resume a previous session. |
| \`--max-ai-credits=CREDITS\` | Set a soft maximum. |
| \`-C DIRECTORY\` | Change working directory. |

## Environment variables

| Variable | Description |
| --- | --- |
| \`COPILOT_MODEL\` | Set the AI model. |
| \`COPILOT_GITHUB_TOKEN\`, \`GH_TOKEN\` | An authentication token. |

### OTel environment variables

| Variable | Default | Description |
| --- | --- | --- |
| \`OTEL_SERVICE_NAME\` | \`github-copilot\` | Service name. |
`;

describe('copilotSettingType', () => {
  it('reads simple types, quoted unions, and anything else as JSON', () => {
    expect(copilotSettingType('`boolean`')).toStrictEqual({ valueType: 'boolean', allowed: [] });
    expect(copilotSettingType('`string[]`')).toStrictEqual({ valueType: 'string[]', allowed: [] });
    expect(copilotSettingType('`"on"` \\| `"off"`')).toStrictEqual({
      valueType: 'enum',
      allowed: ['on', 'off'],
    });
    expect(copilotSettingType('`Record<string, boolean>`')).toStrictEqual({
      valueType: 'json',
      allowed: [],
    });
  });
});

describe('copilotDefault', () => {
  it('takes the first code span and drops its quotes', () => {
    expect(copilotDefault('`"once"`')).toBe('once');
    expect(copilotDefault('`true` (macOS), `false` (other)')).toBe('true');
    expect(copilotDefault('unset')).toBeNull();
    expect(copilotDefault('varies')).toBeNull();
  });
});

describe('parseCopilotFlags', () => {
  it('keys a flag by its long name and names its aliases', () => {
    const flags = parseCopilotFlags(COMMANDS);
    expect(flags.map((flag) => [flag.key, flag.valueType])).toStrictEqual([
      ['--allow-all', 'boolean'],
      ['--effort', 'enum'],
      ['--resume', 'string'],
      ['--max-ai-credits', 'number'],
      ['-C', 'string'],
    ]);
    expect(flags[1]).toMatchObject({
      allowed: ['low', 'medium', 'high'],
      description:
        'Set the reasoning effort level (low, medium, or high). (alias: --reasoning-effort)',
      docUrl: `${COPILOT_COMMAND_DOCS}#command-line-options`,
    });
  });
});

describe('buildCopilotCatalog', () => {
  it('lists user and repository settings, env vars and flags, sorted and without repeats', () => {
    const catalog = buildCopilotCatalog({ configDir: CONFIG_DIR, commandReference: COMMANDS });
    expect(catalog.map((knob) => `${knob.kind} ${knob.key}`)).toStrictEqual([
      'env COPILOT_GITHUB_TOKEN',
      'env COPILOT_MODEL',
      'env GH_TOKEN',
      'env OTEL_SERVICE_NAME',
      'flag --allow-all',
      'flag --effort',
      'flag --max-ai-credits',
      'flag --resume',
      'flag -C',
      'setting allowedUrls',
      'setting askUser',
      'setting banner',
      'setting contextTier',
      'setting hooks',
      'setting model',
    ]);
    const byKey = new Map(catalog.map((knob) => [knob.key, knob]));
    expect(byKey.get('banner')).toMatchObject({
      valueType: 'enum',
      allowed: ['always', 'once', 'never'],
      defaultValue: 'once',
      appliesAt: 'next-launch',
      docUrl: `${COPILOT_CONFIG_DOCS}#user-settings-copilotsettingsjson`,
    });
    // The user table wins over the repository one for a key in both.
    expect(byKey.get('model')).toMatchObject({
      description: 'AI model to use.',
      defaultValue: null,
    });
    expect(byKey.get('contextTier')).toMatchObject({
      docUrl: `${COPILOT_CONFIG_DOCS}#repository-settings-githubcopilotsettingsjson`,
    });
    expect(byKey.get('OTEL_SERVICE_NAME')).toMatchObject({ defaultValue: 'github-copilot' });
  });
});
