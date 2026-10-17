import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../../authoring/frontmatter.js';
import { findTemplate } from '../../authoring/templates.js';
import { resolveClaudePaths } from '../../paths.js';
import type { LibraryPlace } from '../types.js';

import { COPILOT_PROMPT_LIMIT, copilotTools } from './agent-file.js';
import { copilotAgentFiles, copilotLibrary, copilotSkills } from './library.js';

const home = '/home/u';

function place(env: Readonly<Record<string, string>> = {}): LibraryPlace {
  return {
    home,
    env,
    claude: resolveClaudePaths({ home, platform: 'linux', env: {} }),
    cwd: '/repo/app',
    gitRoot: '/repo',
    plugins: [],
  };
}

function agentTemplate(id: string): Parameters<typeof copilotAgentFiles.render>[0] {
  const template = findTemplate(id);
  if (template?.kind !== 'agent') {
    throw new Error(`no agent template ${id}`);
  }
  return template.spec;
}

describe('Copilot CLI skill folders', () => {
  it('reads the three project folders in cwd and the git root, then the user folders', () => {
    expect(
      copilotSkills.folders(place()).map((folder) => [folder.dir, folder.scope]),
    ).toStrictEqual([
      ['/repo/app/.github/skills', 'project'],
      ['/repo/app/.agents/skills', 'project'],
      ['/repo/app/.claude/skills', 'project'],
      ['/repo/.github/skills', 'project'],
      ['/repo/.agents/skills', 'project'],
      ['/repo/.claude/skills', 'project'],
      ['/home/u/.copilot/skills', 'user'],
      ['/home/u/.agents/skills', 'user'],
    ]);
  });

  it('follows COPILOT_HOME and has no /overlord skill yet', () => {
    const dirs = copilotSkills.folders(place({ COPILOT_HOME: '/data/copilot' }));
    expect(dirs.map((folder) => folder.dir)).toContain('/data/copilot/skills');
    expect(copilotSkills.transfer).toBeUndefined();
    expect(copilotLibrary.skills).toBe(copilotSkills);
  });
});

describe('Copilot CLI agent files', () => {
  it('lives in ~/.copilot/agents and .github/agents as .agent.md', () => {
    expect(copilotAgentFiles.suffix).toBe('.agent.md');
    expect(copilotAgentFiles.folders(place()).map((folder) => folder.dir)).toStrictEqual([
      '/home/u/.copilot/agents',
      '/repo/app/.github/agents',
      '/repo/.github/agents',
    ]);
    expect(copilotAgentFiles.nameOf('', '/repo/.github/agents/reviewer.agent.md')).toBe('reviewer');
    expect(copilotAgentFiles.nameOf('', '/repo/.github/agents/plain.md')).toBe('plain');
  });

  it('maps a Claude template onto Copilot fields and tool aliases', () => {
    const text = copilotAgentFiles.render(agentTemplate('agent-reviewer'));
    const parsed = parseFrontmatter(text);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }
    expect(parsed.data).toStrictEqual({
      name: 'code-reviewer',
      description: expect.stringContaining('Reviews code changes') as unknown,
      tools: ['read', 'search', 'execute'],
    });
    expect(parsed.body).toContain('You are a careful code reviewer.');
    expect(copilotAgentFiles.validate(text)).toStrictEqual([]);
    expect(copilotTools('Read, Write, Edit, Unknown')).toStrictEqual(['read', 'edit']);
    expect(copilotTools([])).toStrictEqual([]);
  });

  it('sets the name of a draft and leaves text that does not parse', () => {
    const draft = '---\nname: x\ndescription: Does things.\nmodel: gpt-5\n---\n\nDo it.\n';
    expect(copilotAgentFiles.withName(draft, 'helper')).toBe(
      '---\nname: helper\ndescription: Does things.\nmodel: gpt-5\n---\n\nDo it.\n',
    );
    expect(copilotAgentFiles.withName('plain text', 'helper')).toBe('plain text');
    expect(copilotAgentFiles.withName('---\nname: x\n---\nNo description.\n', 'y')).toBe(
      '---\nname: x\n---\nNo description.\n',
    );
  });

  it('reports what Copilot would refuse or ignore', () => {
    const issues = (text: string): string[] =>
      copilotAgentFiles.validate(text).map((issue) => `${issue.severity} ${issue.message}`);
    expect(issues('no frontmatter')).toStrictEqual([
      'error The file must start with a "---" line that opens the frontmatter.',
    ]);
    expect(issues('---\nname: a\n---\nBody.\n')).toStrictEqual(['error description is required.']);
    expect(
      issues('---\ndescription: d\ntarget: cli\ninfer: true\ncolor: red\n---\n'),
    ).toStrictEqual([
      'error target must be vscode or github-copilot.',
      'warning Unknown field "color". Copilot CLI ignores it.',
      'warning infer is retired. Use disable-model-invocation and user-invocable instead.',
      'warning The body is empty, so the agent has no prompt.',
    ]);
    const long = `---\ndescription: d\n---\n\n${'x'.repeat(COPILOT_PROMPT_LIMIT + 1)}\n`;
    expect(issues(long)[0]).toMatch(/^error The prompt is \d+ characters/u);
    expect(copilotAgentFiles.withName(long, 'y')).toBe(long);
  });

  it('tells Claude the draft is for Copilot CLI', () => {
    expect(copilotAgentFiles.guide).toMatch(/^Write a GitHub Copilot CLI custom agent file/u);
    expect(copilotAgentFiles.guide).not.toMatch(/[\u2013\u2014]/u);
  });
});
