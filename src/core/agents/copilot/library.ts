// Copilot CLI's skills and custom agents. `copilot skill --help` (1.0.89)
// lists the skill folders: .github/skills, .agents/skills and .claude/skills
// in the repository, and ~/.copilot/skills and ~/.agents/skills for the user.
// So a project's .claude/skills is read by Claude Code and Copilot alike,
// while ~/.claude/skills is Claude's alone. Custom agents are .agent.md files
// in .github/agents and ~/.copilot/agents, and the user's win a name clash.
// There is no /overlord skill yet, since Overlord cannot continue a Copilot
// session in a tab.

import path from 'node:path';

import { baseName, cwdAndGitRoot, folder, projectFolders } from '../../authoring/folders.js';
import type {
  AgentFilesFacet,
  LibraryFacet,
  LibraryFolder,
  LibraryPlace,
  SkillsFacet,
} from '../types.js';

import {
  COPILOT_AGENT_GUIDE,
  COPILOT_AGENT_SUFFIX,
  copilotAgentWithName,
  renderCopilotAgent,
  validateCopilotAgent,
} from './agent-file.js';
import { copilotHome } from './observer.js';

const PROJECT_SKILLS: readonly string[] = [
  path.join('.github', 'skills'),
  path.join('.agents', 'skills'),
  path.join('.claude', 'skills'),
];

function projectDirs(place: LibraryPlace): string[] {
  return place.cwd === null ? [] : cwdAndGitRoot(place.cwd, place.gitRoot);
}

function skillFolders(place: LibraryPlace): LibraryFolder[] {
  return [
    ...projectFolders(projectDirs(place), PROJECT_SKILLS),
    folder(path.join(copilotHome(place), 'skills'), 'user'),
    folder(path.join(place.home, '.agents', 'skills'), 'user'),
  ];
}

function agentFolders(place: LibraryPlace): LibraryFolder[] {
  return [
    folder(path.join(copilotHome(place), 'agents'), 'user'),
    ...projectFolders(projectDirs(place), [path.join('.github', 'agents')]),
  ];
}

export const copilotSkills: SkillsFacet = {
  folders: skillFolders,
  nested: null,
  synced: false,
  ranked: true,
  reserved: [],
  manualOnly: null,
  managedOffEnv: null,
  listingLimit: null,
};

export const copilotAgentFiles: AgentFilesFacet = {
  suffix: COPILOT_AGENT_SUFFIX,
  folders: agentFolders,
  // The file name is the agent's id, which is what --agent takes.
  nameOf: (_text, file) => baseName(file, COPILOT_AGENT_SUFFIX),
  validate: validateCopilotAgent,
  render: renderCopilotAgent,
  withName: copilotAgentWithName,
  guide: COPILOT_AGENT_GUIDE,
};

export const copilotLibrary: LibraryFacet = { skills: copilotSkills, agents: copilotAgentFiles };
