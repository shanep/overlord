import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import { findTemplate } from '../../authoring/templates.js';
import { resolveClaudePaths } from '../../paths.js';
import type { LibraryPlace } from '../types.js';

import { codexAgentFiles, codexLibrary, codexSkills } from './library.js';

const home = '/home/u';

function place(env: Readonly<Record<string, string>> = {}): LibraryPlace {
  return {
    home,
    env,
    claude: resolveClaudePaths({ home, platform: 'linux', env: {} }),
    cwd: '/repo/packages/app',
    gitRoot: '/repo',
    plugins: [],
  };
}

function issues(text: string): string[] {
  return codexAgentFiles.validate(text).map((issue) => `${issue.severity} ${issue.message}`);
}

function agentTemplate(id: string): Parameters<typeof codexAgentFiles.render>[0] {
  const template = findTemplate(id);
  if (template?.kind !== 'agent') {
    throw new Error(`no agent template ${id}`);
  }
  return template.spec;
}

describe('Codex CLI skill folders', () => {
  it('walks .agents/skills from cwd up to the repository root, then the user and admin folders', () => {
    expect(
      codexSkills.folders(place()).map((folder) => [folder.dir, folder.scope, folder.writable]),
    ).toStrictEqual([
      ['/repo/packages/app/.agents/skills', 'project', true],
      ['/repo/packages/.agents/skills', 'project', true],
      ['/repo/.agents/skills', 'project', true],
      ['/home/u/.agents/skills', 'user', true],
      ['/etc/codex/skills', 'managed', false],
    ]);
    // Two skills with one name are both listed.
    expect(codexSkills.ranked).toBe(false);
    expect(codexLibrary.skills).toBe(codexSkills);
  });

  it('has an /overlord skill that reads the thread id from the shell', () => {
    const text =
      codexSkills.transfer?.text('vscode://shanep.overlord/continue?session=') ?? 'missing';
    expect(codexSkills.transfer?.folder(place({ CODEX_HOME: '/x' }))).toBe(
      '/home/u/.agents/skills',
    );
    expect(text).toMatch(/^---\nname: overlord\ndescription: Move this Codex CLI session/u);
    expect(text).toContain('vscode://shanep.overlord/continue?session=$CODEX_THREAD_ID');
    expect(text).toContain('If CODEX_THREAD_ID is empty');
    expect(text).not.toMatch(/[\u2013\u2014]/u);
  });
});

describe('Codex CLI agent files', () => {
  it('lives in .codex/agents and CODEX_HOME/agents as TOML', () => {
    expect(codexAgentFiles.suffix).toBe('.toml');
    expect(
      codexAgentFiles.folders(place({ CODEX_HOME: '/data/codex' })).map((f) => f.dir),
    ).toStrictEqual([
      '/repo/packages/app/.codex/agents',
      '/repo/packages/.codex/agents',
      '/repo/.codex/agents',
      '/data/codex/agents',
    ]);
    expect(codexAgentFiles.nameOf('name = "pr_explorer"\n', '/a/explorer.toml')).toBe(
      'pr_explorer',
    );
    expect(codexAgentFiles.nameOf('not toml [', '/a/explorer.toml')).toBe('explorer');
  });

  it('turns a Claude template into a valid TOML agent', () => {
    const researcher = codexAgentFiles.render(agentTemplate('agent-researcher'));
    expect({ ...parse(researcher) }).toStrictEqual({
      name: 'researcher',
      description: expect.stringContaining('Answers questions') as unknown,
      developer_instructions: expect.stringContaining('You find answers') as unknown,
      sandbox_mode: 'read-only',
    });
    expect(codexAgentFiles.validate(researcher)).toStrictEqual([]);
    // A template that can edit files keeps the parent's sandbox.
    const writer = parse(codexAgentFiles.render(agentTemplate('agent-test-writer')));
    expect(writer['sandbox_mode']).toBeUndefined();
  });

  it('turns a Markdown draft into TOML with its name set, keeping quotes and backslashes', () => {
    const draft =
      '---\nname: drafted\ndescription: Says "hi".\nsandbox_mode: read-only\ncolor: red\n---\n\nRun `a\\b` then """stop""".\n';
    const text = codexAgentFiles.withName(draft, 'greeter');
    expect({ ...parse(text) }).toStrictEqual({
      name: 'greeter',
      description: 'Says "hi".',
      developer_instructions: 'Run `a\\b` then """stop""".\n',
      sandbox_mode: 'read-only',
    });
    expect(codexAgentFiles.withName(text, 'again')).toContain('name = "again"');
    expect(codexAgentFiles.withName('neither', 'x')).toBe('neither');
    // A table it cannot write back would be lost, so the file is left alone.
    const withTable = 'name = "a"\n\n[mcp_servers.docs]\ncommand = "docs"\n';
    expect(codexAgentFiles.withName(withTable, 'b')).toBe(withTable);
    const quoted = codexAgentFiles.withName('name = "a"\n"my key" = "x"\n', 'b');
    expect({ ...parse(quoted) }).toStrictEqual({ name: 'b', 'my key': 'x' });
  });

  it('escapes characters TOML cannot hold as they are', () => {
    const control = `a${String.fromCodePoint(0x7f)}b${String.fromCodePoint(1)}c`;
    const lone = String.fromCodePoint(0xd8_00);
    const replacement = String.fromCodePoint(0xff_fd);
    const text = codexAgentFiles.render({
      frontmatter: { name: 'odd', description: `${control}"q"\\${lone}` },
      body: `one${String.fromCodePoint(2)}\ttab\r\ntwo\n`,
    });
    expect({ ...parse(text) }).toStrictEqual({
      name: 'odd',
      description: `${control}"q"\\${replacement}`,
      developer_instructions: `one${String.fromCodePoint(2)}\ttab\r\ntwo\n`,
    });
  });

  it('reports what Codex needs', () => {
    expect(issues('name = ')[0]).toMatch(/^error Not valid TOML: /u);
    expect(issues('name = "a"\ndescription = ""\ncolor = "red"\n')).toStrictEqual([
      'error description must be a string that is not empty.',
      'error developer_instructions is required.',
      'warning Unknown key "color". Codex CLI may not read it.',
    ]);
  });

  it('tells Claude the draft is for Codex CLI', () => {
    expect(codexAgentFiles.guide).toMatch(/^Write a Codex CLI custom agent/u);
    expect(codexAgentFiles.guide).not.toMatch(/[\u2013\u2014]/u);
  });
});
