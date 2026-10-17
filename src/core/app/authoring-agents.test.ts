// New skills and agents once Copilot CLI and Codex CLI are in play. The real
// CLIs never run: the registry here says they are installed and gives them
// their folders, and every folder is under the test's temp home.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import { fakeQueries, resultMessage } from '../../../test/fake-claude/fake-query.js';
import { threeAgents, withOne } from '../agents/test-helpers/library-agents.js';

import { createAuthored } from './actions-authoring.js';
import { DESCRIBE_ID } from './authoring.js';
import { loadLibrary } from './library-scan.js';
import type { TestEnv } from './test-helpers/fixtures.js';
import { makeApp, makeEnv, writeText } from './test-helpers/fixtures.js';
import { installTransferSkill, transferSkillPath, transferSkillText } from './transfer.js';

function draftingApp(env: TestEnv, result: string): ReturnType<typeof makeApp> {
  return makeApp(env, {
    queries: fakeQueries((query) => {
      query.emit(resultMessage({ result }));
    }),
  });
}

describe('New agent with other agents in play', () => {
  it('asks which agent it is for and writes a Copilot agent file in its folder', async () => {
    const env = await makeEnv({ workspace: true });
    const workspace = env.host.workspace ?? '';
    const { app } = makeApp(env);
    const folder = path.join(workspace, '.github', 'agents');
    env.host.pickAnswers.push('copilot', 'agent-reviewer', `folder:${folder}`);
    env.host.inputAnswers.push('checker');
    await createAuthored(app.runtime, 'agent', threeAgents());
    const file = path.join(folder, 'checker.agent.md');
    const text = await readFile(file, 'utf8');
    expect(text).toMatch(/^---\nname: checker\ndescription: Reviews code changes/u);
    expect(text).toContain('tools:\n  - read\n  - search\n  - execute\n');
    expect(env.host.opened).toStrictEqual([file]);
    expect(env.host.warnings).toStrictEqual([]);
    expect(env.host.picks[0]).toStrictEqual({
      placeholder: 'Which agent is the new agent for?',
      items: [
        { id: 'claude-code', label: 'Claude Code', description: 'Saved as a .md file' },
        { id: 'copilot', label: 'Copilot CLI', description: 'Saved as a .agent.md file' },
        { id: 'codex', label: 'Codex CLI', description: 'Saved as a .toml file' },
      ],
    });
    expect(env.host.picks[1]?.placeholder).toBe('Start the new Copilot agent from');
    expect(env.host.picks[2]?.items).toStrictEqual([
      {
        id: `folder:${path.join(env.home, '.copilot', 'agents')}`,
        label: 'User: ~/.copilot/agents',
        description: 'Read by Copilot',
      },
      {
        id: `folder:${folder}`,
        label: 'Project: .github/agents',
        description: 'Read by Copilot',
      },
    ]);
  });

  it('has Claude draft a Codex agent and saves it as TOML', async () => {
    const env = await makeEnv();
    const draft =
      '---\nname: x\ndescription: Explores.\nsandbox_mode: read-only\n---\n\nLook around.\n';
    const { app, queries } = draftingApp(env, draft);
    env.host.pickAnswers.push(
      'codex',
      DESCRIBE_ID,
      `folder:${path.join(env.home, '.codex', 'agents')}`,
    );
    env.host.inputAnswers.push('explorer', 'an explorer');
    await createAuthored(app.runtime, 'agent', threeAgents());
    const file = path.join(env.home, '.codex', 'agents', 'explorer.toml');
    expect({ ...parse(await readFile(file, 'utf8')) }).toStrictEqual({
      name: 'explorer',
      description: 'Explores.',
      developer_instructions: 'Look around.\n',
      sandbox_mode: 'read-only',
    });
    expect(queries.queries[0]?.prompts[0]).toMatch(/^Write a Codex CLI custom agent/u);
    expect(env.host.inputs[1]?.prompt).toBe('Describe the Codex agent you want');
    expect(env.host.infos).toStrictEqual([
      'Claude is drafting the Codex agent. It shows in the launcher.',
    ]);
    expect(app.runtime.launcher.runs()[0]?.spec.label).toBe('Draft a new Codex agent');
  });

  it('keeps the Claude Code flow when Claude Code is picked', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    env.host.pickAnswers.push('claude-code', 'agent-reviewer', 'user');
    env.host.inputAnswers.push('checker');
    await createAuthored(app.runtime, 'agent', threeAgents());
    expect(env.host.opened).toStrictEqual([path.join(env.paths.userAgentsDir, 'checker.md')]);
    expect(env.host.picks[2]?.items).toStrictEqual([
      { id: 'user', label: 'User', description: 'Saved in ~/.claude' },
      { id: 'plugin', label: 'Plugin', description: 'Saved in a plugin folder you pick' },
    ]);
  });
});

describe('New skill with other agents in play', () => {
  it('offers every folder with the agents that read it', async () => {
    const env = await makeEnv({ workspace: true });
    const workspace = env.host.workspace ?? '';
    const { app } = makeApp(env);
    const shared = path.join(workspace, '.agents', 'skills');
    env.host.pickAnswers.push('skill-basic', `folder:${shared}`);
    env.host.inputAnswers.push('tidy');
    await createAuthored(app.runtime, 'skill', threeAgents());
    expect(env.host.opened).toStrictEqual([path.join(shared, 'tidy', 'SKILL.md')]);
    const where = env.host.picks[1]?.items ?? [];
    expect(where.map((item) => [item.label, item.description])).toStrictEqual([
      ['User', 'Saved in ~/.claude. Read by Claude.'],
      ['Project', `Saved in ${workspace}/.claude. Read by Claude and Copilot.`],
      ['Plugin', 'Saved in a plugin folder you pick. Read by Claude.'],
      ['Project: .github/skills', 'Read by Copilot'],
      ['Project: .agents/skills', 'Read by Copilot and Codex'],
      ['User: ~/.copilot/skills', 'Read by Copilot'],
      ['User: ~/.agents/skills', 'Read by Copilot and Codex'],
    ]);
  });

  it('tells Claude who else reads a drafted skill', async () => {
    const env = await makeEnv();
    const { app, queries } = draftingApp(env, '---\nname: x\ndescription: d\n---\nSteps.\n');
    env.host.pickAnswers.push(DESCRIBE_ID, 'user');
    env.host.inputAnswers.push('tidy', 'tidy things');
    await createAuthored(app.runtime, 'skill', withOne('codex'));
    expect(queries.queries[0]?.prompts[0]).toContain(
      'Codex CLI also read this file, so always set name and description',
    );
    expect(
      await readFile(path.join(env.paths.userSkillsDir, 'tidy', 'SKILL.md'), 'utf8'),
    ).toContain('name: tidy');
  });
});

describe('Skills and Agents views with other agents in play', () => {
  it('scans what only the other agents read', async () => {
    const env = await makeEnv({ workspace: true });
    const workspace = env.host.workspace ?? '';
    await writeText(
      path.join(workspace, '.agents', 'skills', 'triage', 'SKILL.md'),
      '---\nname: triage\ndescription: d\n---\n',
    );
    await writeText(
      path.join(workspace, '.github', 'agents', 'reviewer.agent.md'),
      '---\ndescription: d\n---\nReview.\n',
    );
    const { app } = makeApp(env);
    const scan = await loadLibrary(app.runtime, threeAgents());
    expect(scan.readers.map((reader) => reader.id)).toStrictEqual([
      'claude-code',
      'copilot',
      'codex',
    ]);
    expect(scan.skill.map((item) => [item.name, ...item.readers])).toStrictEqual([
      ['triage', 'copilot', 'codex'],
    ]);
    expect(scan.agent.map((item) => [item.name, ...item.readers])).toStrictEqual([
      ['reviewer', 'copilot'],
    ]);
    const alone = await loadLibrary(app.runtime);
    expect(alone.skill).toStrictEqual([]);
    expect(alone.readers.map((reader) => reader.id)).toStrictEqual(['claude-code']);
  });
});

describe('/overlord with Codex CLI in play', () => {
  it('writes the skill for Claude Code and for Codex CLI', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    env.host.confirmAnswers.push(true);
    await installTransferSkill(app.runtime, 'vscode', withOne('codex'));
    const codexFile = path.join(env.home, '.agents', 'skills', 'overlord', 'SKILL.md');
    expect(env.host.questions).toStrictEqual([
      {
        message: `Add the /overlord command to Claude Code and Codex CLI? It writes ${transferSkillPath(app.runtime)} and ${codexFile}.`,
        action: 'Add /overlord',
      },
    ]);
    expect(await readFile(transferSkillPath(app.runtime), 'utf8')).toBe(
      transferSkillText('vscode'),
    );
    expect(await readFile(codexFile, 'utf8')).toContain('session=$CODEX_THREAD_ID');
    expect(env.host.infos).toStrictEqual([
      'Added /overlord. Type it in any Claude Code or Codex CLI session to move it here.',
    ]);
  });

  it('leaves Copilot CLI out, since Overlord cannot continue its sessions yet', async () => {
    const env = await makeEnv();
    const { app } = makeApp(env);
    await installTransferSkill(app.runtime, 'vscode', withOne('copilot'));
    expect(env.host.questions[0]?.message).toBe(
      `Add the /overlord command to Claude Code? It writes ${transferSkillPath(app.runtime)}.`,
    );
  });
});
