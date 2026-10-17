// Codex CLI's skills and custom agents. The Codex docs (read 2026-10-17) list
// the skill folders: .agents/skills in every folder from cwd up to the
// repository root, ~/.agents/skills for the user (in the home folder, not
// CODEX_HOME), and /etc/codex/skills for an administrator. Two skills with
// one name are both listed. Custom agents are TOML files in .codex/agents
// and $CODEX_HOME/agents. Copilot CLI reads ~/.agents/skills too, so the
// /overlord skill for Codex says what to do when its thread id is missing.

import path from 'node:path';

import {
  baseName,
  cwdToGitRoot,
  folder,
  projectFolders,
  readOnlyFolder,
} from '../../authoring/folders.js';
import type {
  AgentFilesFacet,
  LibraryFacet,
  LibraryFolder,
  LibraryPlace,
  SkillsFacet,
  TransferSkill,
} from '../types.js';

import {
  CODEX_AGENT_GUIDE,
  CODEX_AGENT_SUFFIX,
  codexAgentName,
  codexAgentWithName,
  renderCodexAgent,
  validateCodexAgent,
} from './agent-file.js';
import { codexHome } from './observer.js';

const ADMIN_SKILLS = '/etc/codex/skills';

function projectDirs(place: LibraryPlace): string[] {
  return place.cwd === null ? [] : cwdToGitRoot(place.cwd, place.gitRoot);
}

function userSkills(place: LibraryPlace): string {
  return path.join(place.home, '.agents', 'skills');
}

function skillFolders(place: LibraryPlace): LibraryFolder[] {
  return [
    ...projectFolders(projectDirs(place), [path.join('.agents', 'skills')]),
    folder(userSkills(place), 'user'),
    readOnlyFolder(ADMIN_SKILLS, 'managed'),
  ];
}

function agentFolders(place: LibraryPlace): LibraryFolder[] {
  return [
    ...projectFolders(projectDirs(place), [path.join('.codex', 'agents')]),
    folder(path.join(codexHome(place), 'agents'), 'user'),
  ];
}

/**
 * Codex skills cannot run a command before the model reads them, so the
 * model runs it. Codex puts the thread id in CODEX_THREAD_ID for the shell.
 */
function transferText(link: string): string {
  const full = `${link}$CODEX_THREAD_ID`;
  return `---
name: overlord
description: Move this Codex CLI session into Overlord in VS Code, where it continues in an editor tab. Use only when the user runs $overlord.
---

Run this shell command once, exactly as written:

\`\`\`sh
code --open-url "${full}" 2>/dev/null || open "${full}" 2>/dev/null || xdg-open "${full}"
\`\`\`

If CODEX_THREAD_ID is empty, this is not a Codex CLI session: do not run it, and say that Overlord
cannot move this session. Otherwise Overlord is taking over this session in VS Code, and will stop
this terminal's copy once you confirm there. Reply with one short line saying the session is moving
to VS Code. Do nothing else.
`;
}

const codexTransfer: TransferSkill = { folder: userSkills, text: transferText };

export const codexSkills: SkillsFacet = {
  folders: skillFolders,
  nested: null,
  synced: false,
  ranked: false,
  reserved: [],
  manualOnly: null,
  managedOffEnv: null,
  listingLimit: null,
  transfer: codexTransfer,
};

export const codexAgentFiles: AgentFilesFacet = {
  suffix: CODEX_AGENT_SUFFIX,
  folders: agentFolders,
  nameOf: (text, file) => codexAgentName(text) ?? baseName(file, CODEX_AGENT_SUFFIX),
  validate: validateCodexAgent,
  render: renderCodexAgent,
  withName: codexAgentWithName,
  guide: CODEX_AGENT_GUIDE,
};

export const codexLibrary: LibraryFacet = { skills: codexSkills, agents: codexAgentFiles };
