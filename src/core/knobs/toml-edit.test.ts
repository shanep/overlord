import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as fc from 'fast-check';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AtomicWrite } from './atomic-file.js';
import {
  applyTomlEdit,
  applyTomlEdits,
  editTomlFile,
  formatTomlKey,
  formatTomlValue,
  parseTomlKey,
  type TomlEdit,
  type TomlEditResult,
  type TomlFileResult,
} from './toml-edit.js';
import { verifyEdit } from './toml-verify.js';

const tamper = vi.hoisted(() => ({ next: false }));

vi.mock(import('./atomic-file.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileAtomic: async (write: AtomicWrite): Promise<void> => {
      const content = tamper.next ? `${write.content}stray = 1\n` : write.content;
      tamper.next = false;
      await actual.writeFileAtomic({ ...write, content });
    },
  };
});

/** A config.toml the way people keep one: comments, blank lines, dotted and quoted keys. */
const CONFIG = `# Codex config, kept in my dotfiles.
model = "gpt-5-codex"   # the default
model_reasoning_effort = "high"
approval_policy = "on-request"

# Sandbox
sandbox_mode = "workspace-write"
instructions = """
Use [brackets] and # signs freely.
"""

[sandbox_workspace_write]
network_access = false
writable_roots = [
  "/tmp",   # scratch ]
  "~/work",
]

[mcp_servers."docs.server"]
command = "npx"
args = ["-y", "docs-mcp"]
env = { API = "x" }

[profiles.'my fast']
  model = 'gpt-5-mini'
  tools.web_search = true

[[hooks.pre]]
command = "echo"

# Terminal UI
[tui]
notifications = true
`;

interface LineDiff {
  readonly removed: readonly string[];
  readonly added: readonly string[];
}

/** The lines an edit took out and put in. Every edit here is one hunk, so a common prefix and suffix are enough. */
function lineDiff(before: string, after: string): LineDiff {
  const left = before.split('\n');
  const right = after.split('\n');
  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left.at(-1 - tail) === right.at(-1 - tail)
  ) {
    tail += 1;
  }
  return {
    removed: left.slice(head, left.length - tail),
    added: right.slice(head, right.length - tail),
  };
}

function edited(text: string, edit: TomlEdit): string {
  const result = applyTomlEdit(text, edit);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.text;
}

function errorOf(result: TomlEditResult | TomlFileResult): string {
  return result.ok ? '' : result.error;
}

describe('applyTomlEdit', () => {
  describe('set on an existing key', () => {
    it('changes only the value and keeps the trailing comment', () => {
      const after = edited(CONFIG, { op: 'set', path: ['model'], value: 'o3' });
      expect(lineDiff(CONFIG, after)).toStrictEqual({
        removed: ['model = "gpt-5-codex"   # the default'],
        added: ['model = "o3"   # the default'],
      });
    });

    it('replaces a multi-line array with one line', () => {
      const after = edited(CONFIG, {
        op: 'set',
        path: ['sandbox_workspace_write', 'writable_roots'],
        value: ['/tmp'],
      });
      expect(lineDiff(CONFIG, after)).toStrictEqual({
        removed: ['writable_roots = [', '  "/tmp",   # scratch ]', '  "~/work",', ']'],
        added: ['writable_roots = ["/tmp"]'],
      });
    });

    it('finds dotted keys inside a table and keeps their indent', () => {
      const after = edited(CONFIG, {
        op: 'set',
        path: ['profiles', 'my fast', 'tools', 'web_search'],
        value: false,
      });
      expect(lineDiff(CONFIG, after)).toStrictEqual({
        removed: ['  tools.web_search = true'],
        added: ['  tools.web_search = false'],
      });
    });

    it('finds keys under a quoted table name', () => {
      const after = edited(CONFIG, {
        op: 'set',
        path: ['mcp_servers', 'docs.server', 'command'],
        value: 'node',
      });
      expect(lineDiff(CONFIG, after)).toStrictEqual({
        removed: ['command = "npx"'],
        added: ['command = "node"'],
      });
    });

    it('reports no change when the value is already there', () => {
      expect(
        applyTomlEdit(CONFIG, { op: 'set', path: ['tui', 'notifications'], value: true }),
      ).toStrictEqual({
        ok: true,
        text: CONFIG,
        changed: false,
      });
    });
  });

  describe('set on a new key', () => {
    it('adds it after the last key of its table', () => {
      const after = edited(CONFIG, {
        op: 'set',
        path: ['sandbox_workspace_write', 'exclude_slash_tmp'],
        value: true,
      });
      expect(lineDiff(CONFIG, after)).toStrictEqual({
        removed: [],
        added: ['exclude_slash_tmp = true'],
      });
      expect(after).toContain(']\nexclude_slash_tmp = true\n\n[mcp_servers');
    });

    it('copies the indent of the keys around it', () => {
      const after = edited(CONFIG, {
        op: 'set',
        path: ['profiles', 'my fast', 'approval_policy'],
        value: 'never',
      });
      expect(after).toContain(
        '  tools.web_search = true\n  approval_policy = "never"\n\n[[hooks.pre]]',
      );
    });

    it('adds a root key after the last root key, past a multi-line string', () => {
      const after = edited(CONFIG, { op: 'set', path: ['hide_agent_reasoning'], value: true });
      expect(lineDiff(CONFIG, after)).toStrictEqual({
        removed: [],
        added: ['hide_agent_reasoning = true'],
      });
      expect(after).toContain('"""\nhide_agent_reasoning = true\n\n[sandbox_workspace_write]');
    });

    it('adds a root key above the first table when the root has none', () => {
      const text = '# top\n\n# servers\n[mcp_servers.a]\ncommand = "a"\n';
      expect(edited(text, { op: 'set', path: ['model'], value: 'o3' })).toBe(
        '# top\n\nmodel = "o3"\n\n# servers\n[mcp_servers.a]\ncommand = "a"\n',
      );
    });

    it('starts a new [section] at the end when the table has no header', () => {
      const after = edited(CONFIG, { op: 'set', path: ['otel', 'environment'], value: 'dev' });
      expect(after).toBe(`${CONFIG}\n[otel]\nenvironment = "dev"\n`);
    });

    it('puts a key next to its siblings when dotted keys made the table', () => {
      const text = 'otel.environment = "dev"\nmodel = "o3"\n';
      expect(edited(text, { op: 'set', path: ['otel', 'log_user_prompt'], value: false })).toBe(
        'otel.environment = "dev"\notel.log_user_prompt = false\nmodel = "o3"\n',
      );
    });

    it('creates the first key of an empty file', () => {
      expect(edited('', { op: 'set', path: ['model'], value: 'o3' })).toBe('model = "o3"\n');
      expect(edited('', { op: 'set', path: ['otel', 'exporter'], value: 'none' })).toBe(
        '[otel]\nexporter = "none"\n',
      );
    });

    it('fills an empty table right under its header', () => {
      const text = '[otel]\n\n[tui]\nnotifications = true\n';
      expect(edited(text, { op: 'set', path: ['otel', 'environment'], value: 'dev' })).toBe(
        '[otel]\nenvironment = "dev"\n\n[tui]\nnotifications = true\n',
      );
    });
  });

  describe('remove', () => {
    it('removes only the key lines, multi-line values included', () => {
      const after = edited(CONFIG, {
        op: 'remove',
        path: ['sandbox_workspace_write', 'writable_roots'],
      });
      expect(lineDiff(CONFIG, after)).toStrictEqual({
        removed: ['writable_roots = [', '  "/tmp",   # scratch ]', '  "~/work",', ']'],
        added: [],
      });
    });

    it('removes a multi-line string', () => {
      const after = edited(CONFIG, { op: 'remove', path: ['instructions'] });
      expect(lineDiff(CONFIG, after)).toStrictEqual({
        removed: ['instructions = """', 'Use [brackets] and # signs freely.', '"""'],
        added: [],
      });
    });

    it('is no change when the key is not there', () => {
      expect(applyTomlEdit(CONFIG, { op: 'remove', path: ['tui', 'theme'] })).toStrictEqual({
        ok: true,
        text: CONFIG,
        changed: false,
      });
    });

    it('refuses a table', () => {
      expect(errorOf(applyTomlEdit(CONFIG, { op: 'remove', path: ['tui'] }))).toBe(
        'tui is a table. Remove its section instead.',
      );
    });
  });

  describe('sections', () => {
    it('adds a section at the end with a blank line before it', () => {
      const after = edited(CONFIG, {
        op: 'add-section',
        table: ['otel', 'exporter', 'otlp-http'],
        entries: [
          { key: ['endpoint'], value: 'http://127.0.0.1:4318' },
          { key: ['protocol'], value: 'binary' },
        ],
      });
      expect(after).toBe(
        `${CONFIG}\n[otel.exporter.otlp-http]\nendpoint = "http://127.0.0.1:4318"\nprotocol = "binary"\n`,
      );
    });

    it('does not add a second blank line when the file ends with one', () => {
      expect(edited('a = 1\n\n', { op: 'add-section', table: ['otel'], entries: [] })).toBe(
        'a = 1\n\n[otel]\n',
      );
    });

    it('refuses a table that already has keys', () => {
      expect(
        errorOf(applyTomlEdit(CONFIG, { op: 'add-section', table: ['tui'], entries: [] })),
      ).toBe('[tui] already exists. Set its keys one at a time instead.');
      const dotted = applyTomlEdit('otel.a = 1\n', {
        op: 'add-section',
        table: ['otel'],
        entries: [],
      });
      expect(errorOf(dotted)).toBe('[otel] already exists. Set its keys one at a time instead.');
    });

    it('refuses an empty table name', () => {
      expect(errorOf(applyTomlEdit(CONFIG, { op: 'add-section', table: [], entries: [] }))).toBe(
        'The table name is empty.',
      );
    });

    it('removes a section in the middle and the blank lines after it', () => {
      const after = edited(CONFIG, { op: 'remove-section', table: ['sandbox_workspace_write'] });
      expect(lineDiff(CONFIG, after)).toStrictEqual({
        removed: [
          '[sandbox_workspace_write]',
          'network_access = false',
          'writable_roots = [',
          '  "/tmp",   # scratch ]',
          '  "~/work",',
          ']',
          '',
        ],
        added: [],
      });
    });

    it('leaves the comment above the next header alone', () => {
      const text = '[a]\nx = 1\n\n# about b\n[b]\ny = 2\n';
      expect(edited(text, { op: 'remove-section', table: ['a'] })).toBe('# about b\n[b]\ny = 2\n');
      expect(edited(text, { op: 'remove-section', table: ['c'] })).toBe(text);
    });

    it('removes the last section and the blank lines above it', () => {
      const after = edited(CONFIG, { op: 'remove-section', table: ['tui'] });
      expect(after).toBe(
        CONFIG.replace('\n# Terminal UI\n[tui]\nnotifications = true\n', '\n# Terminal UI\n'),
      );
      const plain = 'a = 1\n\n[otel]\nx = 1\n';
      expect(edited(plain, { op: 'remove-section', table: ['otel'] })).toBe('a = 1\n');
    });

    it('refuses an array of tables', () => {
      const text = '[[hooks.pre]]\ncommand = "echo"\n';
      expect(errorOf(applyTomlEdit(text, { op: 'remove-section', table: ['hooks', 'pre'] }))).toBe(
        '[[hooks.pre]] is an array of tables. Edit the file to change it.',
      );
    });
  });

  describe('refusals', () => {
    it('refuses keys inside inline tables', () => {
      expect(
        errorOf(
          applyTomlEdit(CONFIG, {
            op: 'set',
            path: ['mcp_servers', 'docs.server', 'env', 'API'],
            value: 'y',
          }),
        ),
      ).toBe(
        'mcp_servers."docs.server".env.API is inside an inline table. Set it with -c or edit the file.',
      );
      expect(
        errorOf(
          applyTomlEdit(CONFIG, {
            op: 'set',
            path: ['mcp_servers', 'docs.server', 'env'],
            value: 'y',
          }),
        ),
      ).toBe('mcp_servers."docs.server".env is an inline table. Set it with -c or edit the file.');
    });

    it('refuses keys inside arrays of tables', () => {
      expect(
        errorOf(
          applyTomlEdit(CONFIG, { op: 'set', path: ['hooks', 'pre', 'command'], value: 'x' }),
        ),
      ).toBe('hooks.pre.command is inside an array of tables. Set it with -c or edit the file.');
      const inline = 'servers = [{ name = "a" }]\n';
      expect(errorOf(applyTomlEdit(inline, { op: 'set', path: ['servers'], value: 'x' }))).toBe(
        'servers is a table, not a value.',
      );
    });

    it('refuses to turn a table or a value into the other', () => {
      expect(errorOf(applyTomlEdit(CONFIG, { op: 'set', path: ['tui'], value: 1 }))).toBe(
        'tui is a table, not a value.',
      );
      expect(errorOf(applyTomlEdit(CONFIG, { op: 'set', path: ['model', 'name'], value: 1 }))).toBe(
        'model holds a value, not a table.',
      );
      const nested = '[a.b]\nc = 1\n';
      expect(
        errorOf(applyTomlEdit('a = 1\n', { op: 'set', path: ['a', 'b', 'c'], value: 1 })),
      ).toBe('a holds a value, not a table.');
      expect(errorOf(applyTomlEdit(nested, { op: 'set', path: [], value: 1 }))).toBe(
        'The key is empty.',
      );
    });

    it('leaves a file that does not parse alone', () => {
      expect(
        errorOf(applyTomlEdit('model = \n', { op: 'set', path: ['model'], value: 'o3' })),
      ).toMatch(/^The file was left alone because it is not valid TOML: .+ \(line 1\)$/u);
    });

    it('adds next to dotted siblings inside a table', () => {
      const text = '[x]\na.b = 1\n';
      const result = applyTomlEdit(text, { op: 'set', path: ['x', 'a', 'c'], value: 2 });
      expect(result).toStrictEqual({ ok: true, text: '[x]\na.b = 1\na.c = 2\n', changed: true });
    });
  });

  describe('line endings', () => {
    const crlf = CONFIG.replaceAll('\n', '\r\n');

    it('keeps CRLF on edited and added lines', () => {
      const set = edited(crlf, { op: 'set', path: ['model'], value: 'o3' });
      expect(set).toBe(crlf.replace('"gpt-5-codex"', '"o3"'));
      const added = edited(crlf, { op: 'set', path: ['tui', 'theme'], value: 'dark' });
      expect(added).toBe(`${crlf}theme = "dark"\r\n`);
      const section = edited(crlf, { op: 'set', path: ['otel', 'environment'], value: 'dev' });
      expect(section).toBe(`${crlf}\r\n[otel]\r\nenvironment = "dev"\r\n`);
      expect(section.replaceAll('\r\n', '')).not.toContain('\n');
    });

    it('removes CRLF lines whole', () => {
      const after = edited(crlf, { op: 'remove', path: ['approval_policy'] });
      expect(after).toBe(crlf.replace('approval_policy = "on-request"\r\n', ''));
    });

    it('keeps a file with no final newline that way', () => {
      const text = 'model = "gpt-5"\n[tui]\nnotifications = true';
      expect(edited(text, { op: 'set', path: ['tui', 'notifications'], value: false })).toBe(
        'model = "gpt-5"\n[tui]\nnotifications = false',
      );
      expect(edited(text, { op: 'set', path: ['tui', 'theme'], value: 'dark' })).toBe(
        'model = "gpt-5"\n[tui]\nnotifications = true\ntheme = "dark"',
      );
      expect(edited(text, { op: 'set', path: ['otel', 'environment'], value: 'dev' })).toBe(
        'model = "gpt-5"\n[tui]\nnotifications = true\n\n[otel]\nenvironment = "dev"',
      );
      expect(edited(text, { op: 'remove', path: ['tui', 'notifications'] })).toBe(
        'model = "gpt-5"\n[tui]',
      );
      expect(
        edited(`${text}\r\n[x]\r\ny = 1`.replaceAll(/(?<!\r)\n/gu, '\r\n'), {
          op: 'remove',
          path: ['x', 'y'],
        }),
      ).toBe('model = "gpt-5"\r\n[tui]\r\nnotifications = true\r\n[x]');
    });
  });

  it('writes values that parse back to what was set', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'grapheme' }),
          fc.integer(),
          fc.double(),
          fc.boolean(),
          fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean()), { maxLength: 4 }),
        ),
        (value) => {
          const after = edited(CONFIG, { op: 'set', path: ['tui', 'value'], value });
          expect(parse(after)['tui']).toHaveProperty(
            'value',
            typeof value === 'number' && Object.is(value, -0) ? 0 : value,
          );
          expect(lineDiff(CONFIG, after).removed).toStrictEqual([]);
        },
      ),
    );
  });
});

describe('applyTomlEdits', () => {
  it('applies edits in order and stops at the first refusal', () => {
    const edits: TomlEdit[] = [
      { op: 'set', path: ['otel', 'environment'], value: 'dev' },
      { op: 'set', path: ['otel', 'log_user_prompt'], value: false },
    ];
    expect(applyTomlEdits('', edits)).toStrictEqual({
      ok: true,
      text: '[otel]\nenvironment = "dev"\nlog_user_prompt = false\n',
      changed: true,
    });
    expect(
      applyTomlEdits(CONFIG, [...edits, { op: 'set', path: ['tui'], value: 1 }]),
    ).toStrictEqual({
      ok: false,
      error: 'tui is a table, not a value.',
    });
    expect(applyTomlEdits(CONFIG, [])).toStrictEqual({ ok: true, text: CONFIG, changed: false });
  });
});

describe('verifyEdit', () => {
  const none = { cleared: [], set: [], loose: [] };

  it('accepts identical data, NaN, dates and empty tables included', () => {
    const data = parse('a = nan\nb = 1979-05-27T07:32:00Z\n[c]\n');
    expect(verifyEdit(data, parse('a = nan\nb = 1979-05-27T07:32:00Z\n[c]\n'), none)).toBeNull();
  });

  it('names a key that changed, vanished or stayed', () => {
    expect(verifyEdit({ a: 1, b: 2 }, { a: 1, b: 3 }, none)).toBe('b would change too.');
    expect(verifyEdit({ a: 1, b: 2 }, { a: 1 }, none)).toBe('b would be lost.');
    expect(verifyEdit({ a: 1 }, { a: 1 }, { cleared: [['a']], set: [], loose: [] })).toBe(
      'a is still there.',
    );
    expect(
      verifyEdit(
        { a: 1 },
        { a: 2 },
        { cleared: [['a']], set: [{ path: ['a'], value: 3 }], loose: [] },
      ),
    ).toBe('a did not end up with the new value.');
  });
});

describe('keys and values', () => {
  it('formats keys bare when it can and quoted when it must', () => {
    expect(formatTomlKey(['mcp_servers', 'docs.server', 'my key', 'otlp-http'])).toBe(
      'mcp_servers."docs.server"."my key".otlp-http',
    );
  });

  it('parses dotted keys with quotes and escapes', () => {
    expect(parseTomlKey(String.raw`a . "b.c".'d e'."A\t"`)).toStrictEqual([
      'a',
      'b.c',
      'd e',
      'A\t',
    ]);
    expect(parseTomlKey('a.')).toBeNull();
    expect(parseTomlKey('a b')).toBeNull();
    expect(parseTomlKey('"open')).toBeNull();
    expect(parseTomlKey(String.raw`"\q"`)).toBeNull();
  });

  it('formats values the way -c and the file both read them', () => {
    expect(formatTomlValue('a"b\\\u007F')).toBe(String.raw`"a\"b\\\u007f"`);
    expect(formatTomlValue([1, 'x', true])).toBe('[1, "x", true]');
    expect(
      [Number.NaN, Infinity, -Infinity, 1.5].map((value) => formatTomlValue(value)),
    ).toStrictEqual(['nan', 'inf', '-inf', '1.5']);
    expect(formatTomlValue(-(2 ** 53))).toBe('-9007199254740992.0');
    expect(formatTomlValue(1e21)).toBe('1e+21');
    expect(formatTomlValue(42)).toBe('42');
  });
});

describe('editTomlFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-toml-edit-'));
  });

  afterEach(async () => {
    tamper.next = false;
    await rm(dir, { recursive: true, force: true });
  });

  it('edits in place and keeps the old file as .bak', async () => {
    const file = path.join(dir, 'config.toml');
    await writeFile(file, CONFIG);
    const result = await editTomlFile(file, { op: 'set', path: ['model'], value: 'o3' });
    expect(result).toStrictEqual({ ok: true, file, changed: true, backup: `${file}.bak` });
    await expect(readFile(`${file}.bak`, 'utf8')).resolves.toBe(CONFIG);
    await expect(readFile(file, 'utf8')).resolves.toBe(CONFIG.replace('"gpt-5-codex"', '"o3"'));
  });

  it('creates a missing file with no backup and skips writes that change nothing', async () => {
    const file = path.join(dir, 'nested', 'config.toml');
    await expect(editTomlFile(file, [{ op: 'remove', path: ['model'] }])).resolves.toStrictEqual({
      ok: true,
      file,
      changed: false,
      backup: null,
    });
    await expect(
      editTomlFile(file, { op: 'set', path: ['model'], value: 'o3' }),
    ).resolves.toStrictEqual({
      ok: true,
      file,
      changed: true,
      backup: null,
    });
    await expect(readFile(file, 'utf8')).resolves.toBe('model = "o3"\n');
  });

  it('writes through a symlink into its target', async () => {
    const real = path.join(dir, 'dotfiles', 'config.toml');
    await mkdir(path.dirname(real));
    await writeFile(real, 'model = "a"\n');
    const link = path.join(dir, 'config.toml');
    await symlink(real, link);
    const result = await editTomlFile(link, { op: 'set', path: ['model'], value: 'b' });
    expect(result).toStrictEqual({ ok: true, file: real, changed: true, backup: `${real}.bak` });
    await expect(readFile(real, 'utf8')).resolves.toBe('model = "b"\n');
  });

  it('leaves a file it cannot edit alone', async () => {
    const file = path.join(dir, 'config.toml');
    await writeFile(file, CONFIG);
    const result = await editTomlFile(file, {
      op: 'set',
      path: ['hooks', 'pre', 'command'],
      value: 'x',
    });
    expect(errorOf(result)).toBe(
      `${file}: hooks.pre.command is inside an array of tables. Set it with -c or edit the file.`,
    );
    await expect(readFile(file, 'utf8')).resolves.toBe(CONFIG);
  });

  it('puts the old content back when what landed is not what was checked', async () => {
    const file = path.join(dir, 'config.toml');
    await writeFile(file, CONFIG);
    tamper.next = true;
    const result = await editTomlFile(file, { op: 'set', path: ['model'], value: 'o3' });
    expect(errorOf(result)).toBe(
      `${file} changed while it was being written, so the old content was put back.`,
    );
    await expect(readFile(file, 'utf8')).resolves.toBe(CONFIG);

    const fresh = path.join(dir, 'fresh.toml');
    tamper.next = true;
    await editTomlFile(fresh, { op: 'set', path: ['model'], value: 'o3' });
    await expect(readFile(fresh, 'utf8')).rejects.toThrow(/ENOENT/u);
  });

  it('reports a file it cannot read', async () => {
    const result = await editTomlFile(dir, { op: 'set', path: ['model'], value: 'o3' });
    expect(errorOf(result)).toMatch(/^Cannot write .+: EISDIR/u);
  });
});
