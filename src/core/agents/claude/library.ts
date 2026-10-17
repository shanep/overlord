// Claude Code's skills and subagents. Skills come from the managed folder,
// ~/.claude/skills, .claude/skills from cwd up to the git root, and plugins.
// Subagents are .claude/agents/<name>.md files with the frontmatter in
// authoring/schema.ts, which stays where it is and is reached through here.

import path from 'node:path';

import { AGENT_GUIDE } from '../../authoring/draft-prompt.js';
import {
  baseName,
  cwdToGitRoot,
  folder,
  projectFolders,
  readOnlyFolder,
} from '../../authoring/folders.js';
import { renderAgent } from '../../authoring/render.js';
import { parseAgentFile, validateAgentFile } from '../../authoring/validate.js';
import { parseFrontmatter, readText } from '../../context/frontmatter.js';
import { joinUnder } from '../../context/path-tools.js';
import type {
  AgentFilesFacet,
  LibraryFacet,
  LibraryFolder,
  LibraryPlace,
  SkillsFacet,
  TransferSkill,
} from '../types.js';

const SKILLS = path.join('.claude', 'skills');
const AGENTS = path.join('.claude', 'agents');

/** The listing cuts description plus when_to_use at this many characters. */
export const CLAUDE_LISTING_LIMIT = 1536;

function claudeFolders(place: LibraryPlace, kind: 'skills' | 'agents'): LibraryFolder[] {
  const { claude } = place;
  const user = kind === 'skills' ? claude.userSkillsDir : claude.userAgentsDir;
  const relative = kind === 'skills' ? SKILLS : AGENTS;
  const project =
    place.cwd === null ? [] : projectFolders(cwdToGitRoot(place.cwd, place.gitRoot), [relative]);
  return [
    readOnlyFolder(joinUnder(claude.managedDir, '.claude', kind), 'managed'),
    folder(user, 'user'),
    ...project,
    ...place.plugins.map((plugin) =>
      readOnlyFolder(path.join(plugin.root, kind), 'plugin', `${plugin.name}:`),
    ),
  ];
}

/** The /overlord skill. Claude Code runs the !`command` line itself and fills in the session id. */
function transferText(link: string): string {
  const full = `${link}\${CLAUDE_SESSION_ID}`;
  return `---
name: overlord
description: Move this Claude Code session into Overlord in VS Code, where it continues in an editor tab.
disable-model-invocation: true
---

!\`code --open-url "${full}" 2>/dev/null || open "${full}" 2>/dev/null || xdg-open "${full}"\`

Overlord is taking over this session in VS Code, and will stop this terminal's copy once you
confirm there. Reply with one short line saying the session is moving to VS Code. Do nothing else.
`;
}

const claudeTransfer: TransferSkill = {
  folder: (place) => place.claude.userSkillsDir,
  text: transferText,
};

export const claudeSkills: SkillsFacet = {
  folders: (place) => claudeFolders(place, 'skills'),
  nested: SKILLS,
  synced: true,
  ranked: true,
  reserved: ['synced', 'anthropic-skills', 'anthropic-skills:'],
  manualOnly: 'disable-model-invocation',
  managedOffEnv: 'CLAUDE_CODE_DISABLE_POLICY_SKILLS',
  listingLimit: CLAUDE_LISTING_LIMIT,
  transfer: claudeTransfer,
};

/** The file text with its frontmatter name set, when the text parses. */
function withName(text: string, name: string): string {
  const { spec } = parseAgentFile(text);
  return spec === null
    ? text
    : renderAgent({ ...spec, frontmatter: { ...spec.frontmatter, name } });
}

export const claudeAgentFiles: AgentFilesFacet = {
  suffix: '.md',
  folders: (place) => claudeFolders(place, 'agents'),
  nameOf: (text, file) => readText(parseFrontmatter(text).data['name']) ?? baseName(file, '.md'),
  validate: validateAgentFile,
  render: renderAgent,
  withName,
  guide: AGENT_GUIDE,
};

export const claudeLibrary: LibraryFacet = { skills: claudeSkills, agents: claudeAgentFiles };
