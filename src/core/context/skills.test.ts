import { describe, expect, it } from 'vitest';

import { codexSkills } from '../agents/codex/library.js';
import { copilotSkills } from '../agents/copilot/library.js';
import { resolveClaudePaths } from '../paths.js';

import {
  discoverSkills,
  SKILL_DESCRIPTION_LIMIT,
  type DiscoveredSkill,
  type SkillInput,
} from './skills.js';
import { CWD, PATHS } from './test-helpers/fixtures.js';
import { createMemoryFs, type MemoryTree } from './test-helpers/memory-fs.js';

function skill(description: string, extra = ''): string {
  return `---\ndescription: ${description}\n${extra}---\n# Body\n`;
}

function input(tree: MemoryTree, overrides: Partial<SkillInput> = {}): SkillInput {
  return {
    fs: createMemoryFs(tree),
    paths: PATHS,
    cwd: `${CWD}/packages/app`,
    gitRoot: CWD,
    addDirs: [],
    touchedFiles: [],
    plugins: [],
    bare: false,
    safeMode: false,
    env: {},
    invoked: [],
    ...overrides,
  };
}

function summary(skills: readonly DiscoveredSkill[]): [string, string, boolean, string | null][] {
  return skills.map((item) => [item.name, item.source, item.listed, item.hiddenReason]);
}

const TREE: MemoryTree = {
  files: {
    '/etc/claude-code/.claude/skills/deploy/SKILL.md': skill('managed deploy'),
    '/home/u/.claude/skills/deploy/SKILL.md': skill('user deploy'),
    '/home/u/.claude/skills/notes/SKILL.md': skill('user notes', 'when_to_use: when asked\n'),
    '/home/u/.claude/skills/Synced/SKILL.md': skill('reserved name'),
    '/home/u/.claude/skills/anthropic-skills/SKILL.md': skill('reserved name'),
    '/home/u/.claude/skills/anthropic-skills:x/SKILL.md': skill('reserved name'),
    '/home/u/.claude/skills/empty/README.md': 'no skill here',
    '/home/u/.claude/skills/synced/bucket/docs/SKILL.md': skill('synced docs'),
    '/home/u/.claude/skills/synced/flat/SKILL.md': skill('synced flat'),
    [`${CWD}/packages/app/.claude/skills/notes/SKILL.md`]: skill('project notes'),
    [`${CWD}/.claude/skills/root/SKILL.md`]:
      '---\nname: renamed\ndisable-model-invocation: true\n---\nfirst line\n',
    [`${CWD}/packages/app/web/.claude/skills/web/SKILL.md`]: '# Web skill\n\nDoes web things.\n',
    '/plugins/p1/skills/deploy/SKILL.md': skill('plugin deploy'),
    '/plugins/p1/skills/synced/SKILL.md': skill('plugins may use any name'),
    '/add/.claude/skills/extra/SKILL.md': skill('add-dir skill'),
  },
};

const PLUGINS = [{ name: 'p1', root: '/plugins/p1' }];

describe('discoverSkills', () => {
  it('finds every source in precedence order and decides what is listed', async () => {
    const found = await discoverSkills(input(TREE, { plugins: PLUGINS, addDirs: ['/add'] }));
    expect(summary(found)).toStrictEqual([
      ['deploy', 'managed', true, null],
      ['deploy', 'user', false, 'A managed skill with the same name takes precedence.'],
      ['notes', 'user', true, null],
      ['notes', 'project', false, 'A user skill with the same name takes precedence.'],
      [
        'renamed',
        'project',
        false,
        'disable-model-invocation is set, so its description is not in context.',
      ],
      ['extra', 'project', true, null],
      ['web', 'project', false, 'It loads once Claude works on a file under web.'],
      ['p1:deploy', 'plugin', true, null],
      ['p1:synced', 'plugin', true, null],
      ['docs', 'claude-ai', true, null],
      ['flat', 'claude-ai', true, null],
    ]);
  });

  it('fills each entry', async () => {
    const found = await discoverSkills(input(TREE, { invoked: ['notes'] }));
    const notes = found.find((item) => item.source === 'user' && item.name === 'notes');
    expect(notes).toStrictEqual({
      name: 'notes',
      source: 'user',
      path: '/home/u/.claude/skills/notes/SKILL.md',
      listed: true,
      invoked: true,
      descriptionChars: 'user notes'.length + 'when asked'.length,
      description: 'user notes',
      hiddenReason: null,
    });
    const root = found.find((item) => item.name === 'renamed');
    expect(root?.description).toBe('first line');
    expect(root?.invoked).toBe(false);
    const web = found.find((item) => item.name === 'web');
    expect(web?.description).toBe('# Web skill');
  });

  it('lists a nested skill once Claude touches a file under it', async () => {
    const found = await discoverSkills(
      input(TREE, { touchedFiles: [`${CWD}/packages/app/web/x/./y.ts`] }),
    );
    expect(found.find((item) => item.name === 'web')?.listed).toBe(true);
  });

  it('caps the description weight at the listing limit', async () => {
    const long = 'x'.repeat(SKILL_DESCRIPTION_LIMIT + 50);
    const tree: MemoryTree = { files: { '/home/u/.claude/skills/long/SKILL.md': skill(long) } };
    const [only] = await discoverSkills(input(tree));
    expect(SKILL_DESCRIPTION_LIMIT).toBe(1536);
    expect(only?.descriptionChars).toBe(1536);
    expect(only?.description).toBe(long);
  });

  it('gives an empty description to a skill with no text', async () => {
    const tree: MemoryTree = { files: { '/home/u/.claude/skills/blank/SKILL.md': '\n  \n' } };
    const [only] = await discoverSkills(input(tree));
    expect(only?.description).toBe('');
    expect(only?.descriptionChars).toBe(0);
  });

  it('searches project dirs only up to the git root, or cwd alone without one', async () => {
    const tree: MemoryTree = {
      files: {
        '/home/u/.claude/skills/up/SKILL.md': skill('user'),
        [`${CWD}/.claude/skills/root/SKILL.md`]: skill('root'),
        '/home/.claude/skills/above/SKILL.md': skill('above the repo'),
      },
    };
    const names = async (
      gitRoot: string | null,
      cwd = `${CWD}/packages/app`,
    ): Promise<string[]> => {
      const found = await discoverSkills(input(tree, { gitRoot, cwd }));
      return found.map((item) => item.name);
    };
    expect(await names(CWD)).toStrictEqual(['up', 'root']);
    expect(await names(null)).toStrictEqual(['up']);
    expect(await names('/elsewhere')).toStrictEqual(['up']);
    expect(await names(CWD, CWD)).toStrictEqual(['up', 'root']);
  });

  it('hides everything in safe mode', async () => {
    const found = await discoverSkills(input(TREE, { safeMode: true, addDirs: ['/add'] }));
    expect(
      found.every(
        (item) => item.hiddenReason === 'The session runs with --safe-mode, which loads no skills.',
      ),
    ).toBe(true);
    expect(found.some((item) => item.listed)).toBe(false);
  });

  it('keeps only --add-dir skills in bare mode, and lets user skills win when managed ones are off', async () => {
    const found = await discoverSkills(input(TREE, { bare: true, addDirs: ['/add'] }));
    const listed = found.filter((item) => item.listed).map((item) => item.name);
    expect(listed).toStrictEqual(['extra']);
    expect(found.find((item) => item.source === 'user')?.hiddenReason).toBe(
      'The session runs with --bare, which loads only skills from --add-dir directories.',
    );
  });

  it('drops managed skills with CLAUDE_CODE_DISABLE_POLICY_SKILLS', async () => {
    const found = await discoverSkills(
      input(TREE, { env: { CLAUDE_CODE_DISABLE_POLICY_SKILLS: '1' } }),
    );
    expect(summary(found).slice(0, 2)).toStrictEqual([
      [
        'deploy',
        'managed',
        false,
        'CLAUDE_CODE_DISABLE_POLICY_SKILLS is set, so managed skills do not load.',
      ],
      ['deploy', 'user', true, null],
    ]);
  });

  it('reads a Windows managed skills dir without breaking', async () => {
    const paths = resolveClaudePaths({ home: '/home/u', platform: 'win32', env: {} });
    const found = await discoverSkills(
      input(TREE, { paths: { ...paths, userSkillsDir: PATHS.userSkillsDir } }),
    );
    expect(found[0]?.source).toBe('user');
  });
});

describe('discoverSkills for other agents', () => {
  const OTHER: MemoryTree = {
    files: {
      [`${CWD}/.claude/skills/notes/SKILL.md`]: skill('claude and copilot notes'),
      [`${CWD}/.github/skills/notes/SKILL.md`]: skill('github notes'),
      [`${CWD}/packages/app/.agents/skills/build/SKILL.md`]: skill('nested build'),
      [`${CWD}/.agents/skills/build/SKILL.md`]: skill('root build'),
      '/home/u/.agents/skills/build/SKILL.md': skill('user build'),
      '/home/u/.copilot/skills/mine/SKILL.md': '---\nname: mine\n---\nFirst line here.\n',
      '/home/u/.claude/skills/claude-only/SKILL.md': skill('claude only'),
      '/home/u/.claude/skills/synced/flat/SKILL.md': skill('synced flat'),
      [`${CWD}/packages/app/web/.claude/skills/web/SKILL.md`]: skill('nested claude'),
    },
  };

  it('reads Codex skills from .agents/skills up to the git root and lists every copy', async () => {
    const found = await discoverSkills(input(OTHER, { skills: codexSkills }));
    expect(summary(found)).toStrictEqual([
      ['build', 'project', true, null],
      ['build', 'project', true, null],
      ['build', 'user', true, null],
    ]);
    expect(found.map((item) => item.path)).toStrictEqual([
      `${CWD}/packages/app/.agents/skills/build/SKILL.md`,
      `${CWD}/.agents/skills/build/SKILL.md`,
      '/home/u/.agents/skills/build/SKILL.md',
    ]);
  });

  it('reads Copilot skills from its folders, including a project .claude/skills', async () => {
    const found = await discoverSkills(input(OTHER, { skills: copilotSkills, cwd: CWD }));
    expect(summary(found)).toStrictEqual([
      ['notes', 'project', true, null],
      ['build', 'project', true, null],
      ['notes', 'project', false, 'A project skill with the same name takes precedence.'],
      ['mine', 'user', true, null],
      ['build', 'user', false, 'A project skill with the same name takes precedence.'],
    ]);
    expect(found.find((item) => item.name === 'mine')?.descriptionChars).toBe(
      'First line here.'.length,
    );
  });

  it('finds no skills for an agent without skill folders', async () => {
    const found = await discoverSkills(input(OTHER, { agentId: 'no-such-agent' }));
    expect(found).toStrictEqual([]);
  });
});
