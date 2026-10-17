import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderAgent } from '../../authoring/render.js';
import { findTemplate } from '../../authoring/templates.js';
import { validateAgentFile } from '../../authoring/validate.js';
import { resolveClaudePaths } from '../../paths.js';
import type { LibraryPlace } from '../types.js';

import { claudeConfig } from './config.js';
import { claudeAgentFiles, claudeLibrary, claudeSkills } from './library.js';

const home = '/home/u';
const claude = {
  ...resolveClaudePaths({ home, platform: 'linux', env: {} }),
  managedDir: '/etc/claude-code',
};

function place(overrides: Partial<LibraryPlace> = {}): LibraryPlace {
  return {
    home,
    env: {},
    claude,
    cwd: '/repo/packages/app',
    gitRoot: '/repo',
    plugins: [{ name: 'p1', root: '/plugins/p1' }],
    ...overrides,
  };
}

describe('Claude Code library facet', () => {
  it('sits on the config facet', () => {
    expect(claudeConfig.library).toBe(claudeLibrary);
  });

  it('reads skills from the managed, user, project and plugin folders as before', () => {
    expect(claudeSkills.folders(place())).toStrictEqual([
      { dir: '/etc/claude-code/.claude/skills', scope: 'managed', prefix: '', writable: false },
      { dir: '/home/u/.claude/skills', scope: 'user', prefix: '', writable: true },
      { dir: '/repo/packages/app/.claude/skills', scope: 'project', prefix: '', writable: true },
      { dir: '/repo/packages/.claude/skills', scope: 'project', prefix: '', writable: true },
      { dir: '/repo/.claude/skills', scope: 'project', prefix: '', writable: true },
      { dir: '/plugins/p1/skills', scope: 'plugin', prefix: 'p1:', writable: false },
    ]);
    expect(
      claudeSkills.folders(place({ cwd: null, plugins: [] })).map((folder) => folder.dir),
    ).toStrictEqual(['/etc/claude-code/.claude/skills', '/home/u/.claude/skills']);
  });

  it('keeps the subagent schema it had', () => {
    const template = findTemplate('agent-reviewer');
    if (template?.kind !== 'agent') {
      throw new Error('template missing');
    }
    const text = claudeAgentFiles.render(template.spec);
    expect(text).toBe(renderAgent(template.spec));
    expect(claudeAgentFiles.validate(text)).toStrictEqual(validateAgentFile(text));
    expect(claudeAgentFiles.withName(text, 'checker')).toMatch(/^---\nname: checker\n/u);
    expect(claudeAgentFiles.withName('no frontmatter', 'x')).toBe('no frontmatter');
    expect(claudeAgentFiles.nameOf(text, '/a/other.md')).toBe('code-reviewer');
    expect(claudeAgentFiles.nameOf('no frontmatter', '/a/other.md')).toBe('other');
    expect(claudeAgentFiles.folders(place({ plugins: [] })).map((folder) => folder.dir)).toContain(
      path.join('/repo', '.claude', 'agents'),
    );
  });

  it('writes the same /overlord skill as before', () => {
    const link = 'vscode://shanep.overlord/continue?session=';
    expect(claudeSkills.transfer?.folder(place())).toBe('/home/u/.claude/skills');
    expect(claudeSkills.transfer?.text(link)).toBe(`---
name: overlord
description: Move this Claude Code session into Overlord in VS Code, where it continues in an editor tab.
disable-model-invocation: true
---

!\`code --open-url "${link}\${CLAUDE_SESSION_ID}" 2>/dev/null || open "${link}\${CLAUDE_SESSION_ID}" 2>/dev/null || xdg-open "${link}\${CLAUDE_SESSION_ID}"\`

Overlord is taking over this session in VS Code, and will stop this terminal's copy once you
confirm there. Reply with one short line saying the session is moving to VS Code. Do nothing else.
`);
  });
});
