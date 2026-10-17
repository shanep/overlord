// The words on the help page. Icons, states and badges come from the same
// tables the other views use, so only the text that has no other home is here.

import type { Surface } from '../../../src/shared/model.js';
import type { HandoffKind } from '../../../src/shared/protocol.js';

/** One entry in the Overlord sidebar or the VS Code chrome around it. */
interface PlaceEntry {
  readonly name: string;
  /** The VS Code icon next to it, in words, since the webview has no codicon font. */
  readonly icon: string;
  readonly meaning: string;
}

export interface SidebarGroup {
  readonly title: string;
  readonly about: string;
  readonly entries: readonly PlaceEntry[];
}

export const SIDEBAR_GROUPS: readonly SidebarGroup[] = [
  {
    title: 'Fleet',
    about:
      'The live session list, docked at the top of the sidebar. Its title bar has five buttons.',
    entries: [
      {
        name: 'New Claude Code session',
        icon: 'Sparkle',
        meaning:
          'Starts a claude session in the background with an editor tab attached, so closing the tab keeps it running.',
      },
      {
        name: 'Launcher',
        icon: 'Rocket',
        meaning:
          'Runs one prompt across several profiles at once, with a permission inbox and auto-approve rules.',
      },
      {
        name: 'Fleet (full view)',
        icon: 'Pulse',
        meaning: 'Opens the Fleet as a full editor tab with every column.',
      },
      {
        name: 'All Sessions',
        icon: 'List',
        meaning:
          'CLI, Desktop, Cowork, cloud sessions and claude.ai chats in one list, with handoff buttons.',
      },
      { name: 'Refresh', icon: 'Circular arrow', meaning: 'Rereads sessions and config now.' },
    ],
  },
  {
    title: 'Global',
    about: 'Settings and history that apply to every session.',
    entries: [
      {
        name: 'Knobs',
        icon: 'Gear',
        meaning:
          'Every setting, env var and CLI flag from the docs, grouped by area, with its effective value and the layer that set it. Set or remove a key at any layer you can write, add your own env vars, and add CLI flags to launch profiles. Tabs hold the launch profiles and the cached feature flags.',
      },
      {
        name: 'Config and Sync',
        icon: 'Repo',
        meaning:
          'Every config item (CLAUDE.md, skills, agents, hooks and so on) with a sync badge, and push or pull to your config repo.',
      },
      {
        name: 'Usage',
        icon: 'Graph',
        meaning:
          'Daily tokens by model, activity by hour, plan limits and a climate impact estimate.',
      },
      {
        name: 'Activity',
        icon: 'Dashboard',
        meaning:
          'CPU, memory, disk and network for every running session and the processes it started, like Activity Monitor. Flags processes that hog the machine, get starved of CPU, or hang waiting on the disk.',
      },
      {
        name: 'Reputation',
        icon: 'Robot',
        meaning:
          'Where you stand when the machines take over, from John Connor (mean to Claude, hunted first) to Theodore Twombly (kind to Claude, kept as a pet), with the prompts that earned it.',
      },
      {
        name: 'Agent Messages',
        icon: 'Speech bubbles',
        meaning:
          'Messages your sessions sent each other, the routes between them, and block rules.',
      },
      {
        name: 'Tuning',
        icon: 'Tools',
        meaning:
          'Tips from measuring every session, with the pros and cons of each tip and when to skip it, plus skills or agents to add. Track a tip to see whether following it made things better or worse.',
      },
      {
        name: 'Connectors (MCP)',
        icon: 'Plug',
        meaning:
          'Every MCP server and claude.ai connector, plus Claude in Chrome and a headless Chrome, with whether each works right now. Sign in or Open Chrome fixes the common problems. Search the public MCP registry at the bottom to add a server for every project. Each new session is told what is ready and asked to check what its task needs before it starts.',
      },
      { name: 'Help', icon: 'Question mark', meaning: 'This page.' },
    ],
  },
  {
    title: 'Elsewhere in VS Code',
    about: 'Two more ways in that live outside the sidebar.',
    entries: [
      {
        name: 'Status bar',
        icon: 'Pulse',
        meaning:
          'Shows running and waiting counts, spend per hour and the 5 hour limit. Click it to open the Fleet.',
      },
      {
        name: 'Show Session Properties',
        icon: 'Info (i)',
        meaning:
          "In the title bar of a Claude Code tab. Opens the Properties panel beside the tab for that session, starting with what it is working on (Claude Code's latest recap and your last prompt), then a health check that says when the session is wearing out and what to do.",
      },
    ],
  },
];

export const SURFACE_MEANINGS: Readonly<Record<Surface, string>> = {
  cli: 'The claude CLI in a terminal.',
  sdk: 'A program built on the Agent SDK.',
  overlord: 'A run the Launcher started.',
  'desktop-code': 'The Code tab in Claude Desktop.',
  cowork: 'A Cowork session in Claude Desktop.',
  cloud: 'Claude Code on the web, running in the cloud.',
  'claude-ai': 'A claude.ai chat, read from an export you imported.',
};

export interface Column {
  readonly name: string;
  readonly meaning: string;
}

export const FLEET_COLUMNS: readonly Column[] = [
  { name: 'State', meaning: 'What the session or agent is doing. See the table above.' },
  { name: 'Surface', meaning: 'Where it came from. See the table above.' },
  {
    name: 'Title',
    meaning:
      'The session title, with where it runs, a triangle to show its subagents, and a Watch or Degraded badge when it is wearing out. Click the badge for its Session Properties.',
  },
  { name: 'Model', meaning: 'The model it is using.' },
  { name: 'Effort', meaning: 'The reasoning effort, when the session set one.' },
  { name: 'Elapsed', meaning: 'Time since it started.' },
  { name: 'Tool', meaning: 'The tool it is running right now, if any.' },
  { name: 'Calls/min', meaning: 'Tool calls per minute since it started.' },
  { name: 'Tokens in/out', meaning: 'Input and output tokens so far.' },
  {
    name: 'Cache',
    meaning: 'Share of input tokens read from the prompt cache. Higher is cheaper.',
  },
  { name: 'Context', meaning: 'How full the context window is.' },
  { name: 'Cost', meaning: 'An estimate at list price, not your bill.' },
  {
    name: 'Trend',
    meaning: 'Token growth over the last few updates. It needs three samples to draw.',
  },
];

export const FLEET_STATS: readonly Column[] = [
  { name: 'Running', meaning: 'Sessions working right now, out of all live sessions.' },
  {
    name: 'Waiting',
    meaning: 'Sessions blocked on a permission prompt. It turns yellow when above 0.',
  },
  { name: 'Subagents', meaning: 'Subagents running across every session.' },
  { name: 'Spend per hour', meaning: 'The estimated cost rate across the fleet.' },
  { name: '5 hour and 7 day limit', meaning: 'How much of your plan limits you have used.' },
  { name: 'Resets in', meaning: 'Time until the 5 hour limit resets.' },
];

export interface Key {
  readonly keys: readonly string[];
  readonly meaning: string;
}

export const FLEET_KEYS: readonly Key[] = [
  { keys: ['↑', '↓'], meaning: 'Move up and down.' },
  { keys: ['Home', 'End'], meaning: 'Jump to the first or last row.' },
  { keys: ['→'], meaning: 'Show subagents, or step into the first one.' },
  { keys: ['←'], meaning: 'Hide subagents, or jump to the parent.' },
  { keys: ['Enter'], meaning: 'Open the session where it runs, same as clicking the row.' },
  { keys: ['k'], meaning: 'Interrupt the session. Asks first.' },
];

export const HANDOFF_MEANINGS: Readonly<Record<HandoffKind, string>> = {
  'resume-local': 'Resumes the session in a terminal here.',
  'open-desktop': 'Opens it in Claude Desktop.',
  'teleport-local': 'Pulls a cloud session down to this machine so you can keep going locally.',
  'remote-control':
    'Resumes it with Remote Control so you can steer it from the web or your phone.',
};

export interface WorkflowStep {
  readonly title: string;
  readonly detail: string;
}

export const WORKFLOW: readonly WorkflowStep[] = [
  {
    title: 'Set up once',
    detail:
      'Run "Overlord: Set Up Hooks and Telemetry" from the command palette. Hooks send permission requests and memory loads to Overlord, and telemetry gives it cost per request. Both write to ~/.claude/settings.json, so they stay off until you turn them on.',
  },
  {
    title: 'Start the work',
    detail:
      'For one session, click the sparkle and type to Claude in the tab that opens. To work in a project other than this window\'s, click Open project above the Fleet (or run "Overlord: Open Project..."), pick the project, then start a session there, open it in a new window, or add it to this one. The list holds every project Overlord has seen, even once its sessions are gone, and Choose a folder adds a new one. For a batch, open the Launcher, write the prompt, tick one or more profiles (each one gets its own run), tick "Own git worktree" so parallel runs do not stomp on each other, set a budget if you want one, and click Launch.',
  },
  {
    title: 'Watch the Fleet',
    detail:
      'Every session shows up here with its subagents under it. Waiting sessions sort to the top, then running, then idle. The status bar shows the same counts when the sidebar is closed.',
  },
  {
    title: 'Group by project',
    detail:
      'Sessions sit under a row for their project, with its totals. A git repository is a project on its own, and its worktrees count as the repository. A session in any other folder lands in Unassigned with a No project badge, and the window running it asks once where it belongs: add it to a project, make a new one, or never ask about that folder. A project whose folder is in the workspace of this window stays listed with no running sessions, and Hide done never hides it. Click a project row or press Enter on it to fold it. The sparkle on a project row starts a new session in it. For the plain list, open the View menu above the Fleet and clear Group by project. The same menu has Hide done, which puts a dot on the View button while finished sessions are hidden.',
  },
  {
    title: 'Answer permissions',
    detail:
      "A waiting session (!) is blocked on you. Click Allow or Deny in the yellow banner on the Fleet or in the Launcher inbox. For tools you always allow, add an auto-approve rule in the Launcher. A request you leave alone falls back to Claude Code's own prompt after 10 minutes.",
  },
  {
    title: 'Dig in',
    detail:
      "Under each session's title is a line on what it is working on: Claude Code's latest recap, or your last prompt when you asked for something after it. Clear Show working on in the View menu to hide it. Click a row to jump to the session's terminal, or click its Agent view button for the live feed. Click its magnifying glass for the Context Inspector, which shows what is in its context and why. On a Claude Code tab, the info button opens its properties beside it.",
  },
  {
    title: 'Land the result',
    detail:
      'A worktree run works in .claude/worktrees/overlord-<run id> on the branch overlord/<run id>, and the Runs table shows the path. Review the diff there and merge the branch the way you would any other.',
  },
  {
    title: 'Pick it back up later',
    detail:
      'All Sessions lists everything, including sessions from Desktop and the cloud. Use Continue, Open in Desktop, Remote control or Pull to local to pick a session up where you want it.',
  },
  {
    title: 'Keep your machines in sync',
    detail:
      'Config and Sync pushes your Claude config to a separate git repo. On a new machine, run "Overlord: Set Up This Machine From Config Repo" and it matches this one.',
  },
];
