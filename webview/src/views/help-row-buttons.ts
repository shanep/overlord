// What each fleet row button does, for the help page.

import type { IconName } from '../components/icon.js';

export interface RowButton {
  readonly icon: IconName;
  readonly name: string;
  readonly meaning: string;
}

export const ROW_BUTTONS: readonly RowButton[] = [
  {
    icon: 'open',
    name: 'Agent view',
    meaning:
      'Opens the agent view: the live feed of thinking and tool calls, a tool timeline and charts.',
  },
  {
    icon: 'context',
    name: 'Context Inspector',
    meaning:
      'Opens the context inspector: the system prompt, every memory file that loaded and why, and every file that did not load and why not.',
  },
  {
    icon: 'move',
    name: 'Move to project',
    meaning:
      'Puts every session in this folder in another project or a new one. For a folder with no git repository, it can also tell Overlord never to ask about it. The m key does the same.',
  },
  {
    icon: 'newSession',
    name: 'New session in project',
    meaning:
      "On a project's row, starts a Claude Code session in that project, in its own worktree when it is a git repository, without switching windows.",
  },
  {
    icon: 'openFolder',
    name: 'Open project folder',
    meaning:
      "On a project's row, adds its folder to this window and shows it in the Explorer, so you can browse, search and edit it like any other folder. The window stays open, so its sessions keep running.",
  },
  {
    icon: 'setFolder',
    name: 'Set project folder',
    meaning: 'On a project you made, picks the folder that Open project folder opens.',
  },
  {
    icon: 'rename',
    name: 'Rename project',
    meaning: 'On the row of a project you made, gives it a new name.',
  },
  {
    icon: 'delete',
    name: 'Delete project',
    meaning:
      'On the row of a project you made, deletes it after asking. Its sessions go back to their repository or to Unassigned.',
  },
  {
    icon: 'relocate',
    name: 'Continue in folder',
    meaning:
      "Continues a copy of the session in a folder you pick, with that folder's CLAUDE.md, settings and memory, in a worktree when the folder is in git. A session still running is stopped first. The original stays in its old folder.",
  },
  {
    icon: 'combine',
    name: 'Combine sessions',
    meaning:
      "Picks other sessions to combine with this one, then starts one new session in this session's project that begins from a digest of them all: what you asked, the files they edited, the commits they made and their last reply. Then it offers to stop the ones still running.",
  },
  {
    icon: 'interrupt',
    name: 'Interrupt',
    meaning: 'Stops the current turn. The session stays open for your next prompt. Asks first.',
  },
  {
    icon: 'stop',
    name: 'Stop',
    meaning: 'Ends the session for good. Asks first.',
  },
];
