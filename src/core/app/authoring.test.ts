import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeQueries, resultMessage } from '../../../test/fake-claude/fake-query.js';
import { findTemplate } from '../authoring/templates.js';
import { isolatedExec } from '../sync/test-helpers/fixtures.js';

import { askName, DESCRIBE_ID, draftText, renderNamed, withName } from './authoring.js';
import type { TestEnv } from './test-helpers/fixtures.js';
import { cloneConfigRepo, makeApp, makeEnv, writeText } from './test-helpers/fixtures.js';

const DRAFT =
  '---\nname: drafted\ndescription: Does things. Use when needed.\n---\n\nYou do things.\n';

function draftingApp(env: TestEnv, reply: Record<string, unknown>): ReturnType<typeof makeApp> {
  return makeApp(env, {
    queries: fakeQueries((query) => {
      query.emit(resultMessage(reply));
    }),
  });
}

describe('withName and renderNamed', () => {
  it('sets the name in parsed agent and skill files and leaves other text alone', () => {
    expect(withName('agent', DRAFT, 'mine')).toContain('name: mine');
    expect(withName('agent', DRAFT, 'mine')).not.toContain('drafted');
    const skill = '---\nname: s\ndescription: d\n---\nSteps.\n';
    expect(withName('skill', skill, 'tidy')).toContain('name: tidy');
    expect(withName('agent', 'no frontmatter', 'x')).toBe('no frontmatter');
    expect(withName('skill', 'no frontmatter', 'x')).toBe('no frontmatter');
  });

  it('renders templates with the chosen name', () => {
    const agentTemplate = findTemplate('agent-reviewer');
    const skillTemplate = findTemplate('skill-basic');
    if (agentTemplate === null || skillTemplate === null) {
      throw new Error('templates missing');
    }
    expect(renderNamed(agentTemplate, 'checker')).toMatch(/^---\nname: checker\n/u);
    expect(renderNamed(skillTemplate, 'summary')).toMatch(/^---\nname: summary\n/u);
  });
});

describe('askName', () => {
  it('returns a valid trimmed name and rejects the rest', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    env.host.inputAnswers.push(null, '  ', '-bad', ' good-name ');
    await expect(askName(app.runtime, 'agent')).resolves.toBeNull();
    await expect(askName(app.runtime, 'agent')).resolves.toBeNull();
    await expect(askName(app.runtime, 'skill')).resolves.toBeNull();
    await expect(askName(app.runtime, 'skill')).resolves.toBe('good-name');
    expect(env.host.errors).toStrictEqual(['Name cannot start with "-".']);
    expect(env.host.inputs[0]).toStrictEqual({
      prompt: 'Name for the new agent: lowercase letters, digits and hyphens',
      value: '',
    });
    expect(env.host.inputs[3]?.prompt).toBe(
      'Name for the new skill: lowercase letters, digits and hyphens',
    );
  });
});

describe('draftText', () => {
  it('has Claude draft the file through the launcher', async () => {
    const env = await makeEnv({ workspace: true });
    const { app, queries } = draftingApp(env, { result: `\`\`\`markdown\n${DRAFT}\`\`\`` });
    env.host.inputAnswers.push(' a helper agent ');
    await expect(draftText(app.runtime, 'agent')).resolves.toBe(DRAFT);
    expect(env.host.inputs[0]?.prompt).toBe('Describe the agent you want');
    expect(env.host.infos).toStrictEqual([
      'Claude is drafting the agent. It shows in the launcher.',
    ]);
    const [run] = app.runtime.launcher.runs();
    expect(run?.spec.label).toBe('Draft a new agent');
    expect(run?.spec.cwd).toBe(env.host.workspace);
    expect(queries.queries[0]?.prompts[0]).toContain('a helper agent');
  });

  it('stops on an empty description and on a failed draft', async () => {
    const env = await makeEnv();
    const { app } = draftingApp(env, { is_error: true, subtype: 'error_during_execution' });
    env.host.inputAnswers.push(null, ' ', 'something');
    await expect(draftText(app.runtime, 'skill')).resolves.toBeNull();
    await expect(draftText(app.runtime, 'skill')).resolves.toBeNull();
    expect(app.runtime.launcher.runs()).toStrictEqual([]);
    await expect(draftText(app.runtime, 'skill')).resolves.toBeNull();
    expect(env.host.errors).toStrictEqual(['Claude could not draft the skill.']);
    expect(app.runtime.launcher.runs()[0]?.spec.cwd).toBe(env.home);
  });

  it('treats a run with no result text as failed', async () => {
    const env = await makeEnv();
    const { app } = draftingApp(env, { result: undefined });
    env.host.inputAnswers.push('something');
    await expect(draftText(app.runtime, 'agent')).resolves.toBeNull();
    expect(env.host.errors).toStrictEqual(['Claude could not draft the agent.']);
  });
});

/**
 * Turns the other agents off. These tests run the real login shell, so
 * Copilot or Codex on this machine's PATH would add an agent picker.
 */
function claudeOnly(env: TestEnv): void {
  const off = { path: '', enabled: false };
  env.host.settings = { ...env.host.settings, agents: { codex: off, copilot: off } };
}

describe('newAgent and newSkill', () => {
  it('offers templates and describe-it, then saves a template to ~/.claude', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    env.host.pickAnswers.push('agent-reviewer', 'user');
    env.host.inputAnswers.push('checker');
    await app.dispatch({ type: 'newAgent' }, {});
    const file = path.join(env.paths.userAgentsDir, 'checker.md');
    expect(await readFile(file, 'utf8')).toMatch(/^---\nname: checker\n/u);
    expect(env.host.opened).toStrictEqual([file]);
    expect(env.host.picks[0]?.placeholder).toBe('Start the new agent from');
    expect(env.host.picks[0]?.items.map((item) => item.id)).toStrictEqual([
      'agent-reviewer',
      'agent-researcher',
      'agent-test-writer',
      DESCRIBE_ID,
    ]);
    expect(env.host.picks[0]?.items[3]).toStrictEqual({
      id: 'describe',
      label: 'Describe it',
      description: 'Write what you want and Claude drafts it.',
    });
    expect(env.host.picks[1]?.placeholder).toBe('Save it where?');
    expect(env.host.picks[1]?.items).toStrictEqual([
      { id: 'user', label: 'User', description: 'Saved in ~/.claude' },
      { id: 'plugin', label: 'Plugin', description: 'Saved in a plugin folder you pick' },
    ]);
    expect(env.host.warnings).toStrictEqual([]);
  });

  it('stops when any step is cancelled', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await app.dispatch({ type: 'newAgent' }, {});
    env.host.pickAnswers.push('not-a-template');
    await app.dispatch({ type: 'newAgent' }, {});
    env.host.pickAnswers.push('agent-reviewer');
    await app.dispatch({ type: 'newAgent' }, {});
    env.host.pickAnswers.push('agent-reviewer', null);
    env.host.inputAnswers.push('x', 'x');
    await app.dispatch({ type: 'newAgent' }, {});
    env.host.pickAnswers.push('agent-reviewer', 'project');
    await app.dispatch({ type: 'newAgent' }, {});
    env.host.pickAnswers.push('skill-basic', 'plugin');
    env.host.inputAnswers.push('s');
    await app.dispatch({ type: 'newSkill' }, {});
    expect(env.host.folderPicks).toStrictEqual(['Pick the plugin folder']);
    expect(env.host.opened).toStrictEqual([]);
  });

  it('saves to the project and to a plugin', async () => {
    const env = await makeEnv({ workspace: true });
    const workspace = env.host.workspace ?? '';
    const plugin = path.join(env.root, 'plugin');
    const { app } = makeApp(env);
    env.host.pickAnswers.push('agent-researcher', 'project', 'skill-arguments', 'plugin');
    env.host.inputAnswers.push('finder', 'fixer');
    env.host.folderAnswers.push(plugin);
    await app.dispatch({ type: 'newAgent' }, {});
    await app.dispatch({ type: 'newSkill' }, {});
    expect(env.host.opened).toStrictEqual([
      path.join(workspace, '.claude', 'agents', 'finder.md'),
      path.join(plugin, 'skills', 'fixer', 'SKILL.md'),
    ]);
    expect(env.host.picks[1]?.items.map((item) => item.id)).toStrictEqual([
      'user',
      'project',
      'plugin',
    ]);
    expect(env.host.picks[1]?.items[1]?.description).toBe(`Saved in ${workspace}/.claude`);
  });

  it('asks before replacing a file that exists', async () => {
    const env = await makeEnv();
    const file = await writeText(path.join(env.paths.userAgentsDir, 'checker.md'), 'old\n');
    const { app } = makeApp(env);
    env.host.pickAnswers.push('agent-reviewer', 'user', 'agent-reviewer', 'user');
    env.host.inputAnswers.push('checker', 'checker');
    env.host.confirmAnswers.push(false, true);
    await app.dispatch({ type: 'newAgent' }, {});
    expect(await readFile(file, 'utf8')).toBe('old\n');
    await app.dispatch({ type: 'newAgent' }, {});
    expect(await readFile(file, 'utf8')).toMatch(/^---\nname: checker\n/u);
    expect(env.host.questions).toStrictEqual([
      { message: `${file} already exists. Replace it?`, action: 'Replace' },
      { message: `${file} already exists. Replace it?`, action: 'Replace' },
    ]);
    expect(env.host.opened).toStrictEqual([file]);
  });

  it('saves a draft and warns about problems in it', async () => {
    const env = await makeEnv();
    const { app } = draftingApp(env, { result: '---\nname: x\n---\nbody\n' });
    env.host.pickAnswers.push(DESCRIBE_ID, 'user');
    env.host.inputAnswers.push('drafty', 'an agent');
    await app.dispatch({ type: 'newAgent' }, {});
    expect(env.host.warnings).toStrictEqual(['Check the new file: description is required.']);
    expect(env.host.opened).toStrictEqual([path.join(env.paths.userAgentsDir, 'drafty.md')]);
  });

  it('stops when the draft fails', async () => {
    const env = await makeEnv();
    const { app } = draftingApp(env, { is_error: true });
    env.host.pickAnswers.push(DESCRIBE_ID);
    env.host.inputAnswers.push('drafty', 'an agent');
    await app.dispatch({ type: 'newAgent' }, {});
    expect(env.host.picks).toHaveLength(1);
    expect(env.host.opened).toStrictEqual([]);
  });

  it('writes user scope files into the config repo and links them back', async () => {
    const env = await makeEnv();
    claudeOnly(env);
    const exec = isolatedExec();
    const repo = await cloneConfigRepo(env, exec);
    const { app } = makeApp(env, { deps: { exec } });
    env.host.pickAnswers.push('agent-reviewer', 'user', 'skill-basic', 'user');
    env.host.inputAnswers.push('checker', 'tidy');
    await app.dispatch({ type: 'newAgent' }, {});
    await app.dispatch({ type: 'newSkill' }, {});
    expect(env.host.picks[1]?.items[0]?.description).toBe(
      'Saved in the config repo, linked into ~/.claude',
    );
    const agentInRepo = path.join(repo, 'agents', 'checker.md');
    expect(env.host.opened).toStrictEqual([
      agentInRepo,
      path.join(repo, 'skills', 'tidy', 'SKILL.md'),
    ]);
    expect(await readlink(path.join(env.paths.userAgentsDir, 'checker.md'))).toBe(agentInRepo);
    expect(await readlink(path.join(env.paths.userSkillsDir, 'tidy'))).toBe(
      path.join(repo, 'skills', 'tidy'),
    );
    const manifest = await readFile(path.join(repo, 'overlord.json'), 'utf8');
    expect(manifest).toContain('"id": "agent:checker"');
    expect(manifest).toContain('"id": "skill:tidy"');
    expect(env.host.warnings).toStrictEqual([]);
  });

  it('warns when the repo file cannot be linked back', async () => {
    const env = await makeEnv();
    claudeOnly(env);
    const exec = isolatedExec();
    await cloneConfigRepo(env, exec);
    await writeText(env.paths.userAgentsDir, 'a file where the folder should be');
    const { app } = makeApp(env, { deps: { exec } });
    env.host.pickAnswers.push('agent-reviewer', 'user');
    env.host.inputAnswers.push('checker');
    await app.dispatch({ type: 'newAgent' }, {});
    expect(env.host.warnings).toHaveLength(1);
    expect(env.host.warnings[0]).toMatch(/^Saved in the config repo, but linking failed: /u);
  });

  it('warns when ~/.claude is outside the home folder', async () => {
    const env = await makeEnv();
    claudeOnly(env);
    const exec = isolatedExec();
    await cloneConfigRepo(env, exec);
    const outside = path.join(env.root, 'elsewhere', 'agents');
    const moved: TestEnv = { ...env, paths: { ...env.paths, userAgentsDir: outside } };
    const { app } = makeApp(moved, { deps: { exec } });
    env.host.pickAnswers.push('agent-reviewer', 'user');
    env.host.inputAnswers.push('checker');
    await app.dispatch({ type: 'newAgent' }, {});
    expect(env.host.warnings).toStrictEqual([
      `Saved in the config repo, but it could not be linked into ${path.join(outside, 'checker.md')}.`,
    ]);
    await expect(lstat(path.join(outside, 'checker.md'))).rejects.toThrow();
  });
});
