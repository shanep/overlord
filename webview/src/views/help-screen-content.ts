// The screen map's words: each place in VS Code an extension can draw into,
// each Overlord piece and where it lives, and the extension points off the
// screen. The help page's map, flow diagrams and tables all read these, so
// one number means one place everywhere.

/** Something an extension can add to VS Code. */
export interface ExtensionPoint {
  readonly name: string;
  /** What an extension can put there, and the API that does it. */
  readonly apis: string;
  /** What Overlord puts there today, or null when it does not use the area yet. */
  readonly overlord: string | null;
}

/** An extension point with a place on the screen, numbered to match the diagram. */
export interface ScreenArea extends ExtensionPoint {
  readonly number: number;
  /** Where its marker sits on the diagram, in the diagram's 960 by 620 grid. */
  readonly at: { readonly x: number; readonly y: number };
}

export const SCREEN_AREAS: readonly ScreenArea[] = [
  {
    number: 1,
    at: { x: 302, y: 42 },
    name: 'Command Palette and Quick Pick',
    apis: 'Commands (contributes.commands), pick lists (showQuickPick, createQuickPick) and one line prompts (showInputBox). They drop down from the top of the window.',
    overlord: 'Every "Overlord:" command, the project picker and the project name prompt.',
  },
  {
    number: 2,
    at: { x: 24, y: 228 },
    name: 'Activity bar',
    apis: 'An icon that opens a view container (viewsContainers.activitybar), with a number badge from a view in it.',
    overlord: 'The Overlord icon, with a badge counting waiting sessions.',
  },
  {
    number: 3,
    at: { x: 168, y: 380 },
    name: 'Primary side bar',
    apis: 'Views inside the container: tree views (registerTreeDataProvider), webview views (registerWebviewViewProvider) and welcome text for empty views (viewsWelcome).',
    overlord: 'Fleet and Session Properties are webview views. Global is a tree view.',
  },
  {
    number: 4,
    at: { x: 176, y: 46 },
    name: 'View title bar',
    apis: 'Icon buttons in a view header (menus view/title), plus inline buttons and right click menus on tree rows (view/item/context).',
    overlord: 'The five Fleet buttons.',
  },
  {
    number: 5,
    at: { x: 702, y: 80 },
    name: 'Editor title bar',
    apis: 'Icon buttons at the right end of the tab row (menus editor/title), shown only when a when clause matches the active tab.',
    overlord: 'The info button on a Claude Code tab.',
  },
  {
    number: 6,
    at: { x: 724, y: 236 },
    name: 'Editor area',
    apis: 'Whole tabs: webview panels (createWebviewPanel), custom editors for a file type (customEditors) and terminals opened as tabs (createTerminal with a viewColumn).',
    overlord:
      'Every full page: Fleet (full view), the agent view, Launcher, Knobs, Usage, this help and the rest. Claude Code sessions run as terminal tabs here.',
  },
  {
    number: 7,
    at: { x: 496, y: 172 },
    name: 'Inside a text editor',
    apis: 'Decorations on code (createTextEditorDecorationType: gutter icons, highlights, text after a line), CodeLens links above a line, hovers, inlay hints, completions and squiggles (createDiagnosticCollection).',
    overlord: null,
  },
  {
    number: 8,
    at: { x: 484, y: 294 },
    name: 'Context menus',
    apis: 'Entries in right click menus on the editor, the Explorer, terminals and tabs (menus editor/context, explorer/context, terminal/context, editor/title/context).',
    overlord: null,
  },
  {
    number: 9,
    at: { x: 722, y: 436 },
    name: 'Panel',
    apis: 'The strip under the editor: views in a panel container (viewsContainers.panel), terminals (createTerminal), logs (createOutputChannel) and the Problems list.',
    overlord: null,
  },
  {
    number: 10,
    at: { x: 852, y: 260 },
    name: 'Secondary side bar',
    apis: 'The Chat view lives here, and an extension can join it as a chat participant or a language model tool. You can also drag any view here, so anything that works in the side bar works here.',
    overlord: null,
  },
  {
    number: 11,
    at: { x: 754, y: 512 },
    name: 'Notifications',
    apis: 'Toasts with buttons (showInformationMessage, showWarningMessage, showErrorMessage) and progress spinners (withProgress).',
    overlord: 'Errors, confirmations and the "Starting Claude Code" progress.',
  },
  {
    number: 12,
    at: { x: 632, y: 606 },
    name: 'Status bar',
    apis: 'Short text with icons on the left or right (createStatusBarItem), with a tooltip, a click command and a warning or error background.',
    overlord: 'Running and waiting counts, spend per hour and the 5 hour limit.',
  },
];

/** Extension points that change VS Code without a place of their own on the screen. */
export const OFF_SCREEN: readonly ExtensionPoint[] = [
  {
    name: 'Settings',
    apis: 'Entries in the Settings editor (contributes.configuration).',
    overlord: 'The overlord.* settings.',
  },
  {
    name: 'Links',
    apis: 'vscode:// links that open the extension from a browser or another app (registerUriHandler).',
    overlord: 'The /overlord command in Claude Code hands a session over with one.',
  },
  {
    name: 'Keyboard shortcuts',
    apis: 'Default keys for commands (contributes.keybindings).',
    overlord: null,
  },
  {
    name: 'Walkthroughs',
    apis: 'A step by step page on the Welcome screen (contributes.walkthroughs).',
    overlord: null,
  },
];

/** One piece of Overlord on the screen, and the area of the map it sits in. */
export interface Piece {
  readonly name: string;
  readonly area: number;
  readonly what: string;
  /** How to get to it. */
  readonly open: string;
}

export const PIECES: readonly Piece[] = [
  {
    name: 'Overlord commands',
    area: 1,
    what: 'Every "Overlord:" command.',
    open: 'Cmd+Shift+P (Ctrl+Shift+P on Linux), then type Overlord.',
  },
  {
    name: 'Overlord icon',
    area: 2,
    what: 'Opens the Overlord sidebar. Its badge counts the sessions waiting on you.',
    open: 'Always in the activity bar.',
  },
  {
    name: 'Fleet',
    area: 3,
    what: 'Every live session and its subagents, grouped by project.',
    open: 'Click the Overlord icon.',
  },
  {
    name: 'Fleet row buttons',
    area: 3,
    what: 'Agent view, Context Inspector, Move to project, Interrupt, Stop and the project buttons.',
    open: 'Hover or select a Fleet row.',
  },
  {
    name: 'Global',
    area: 3,
    what: 'Knobs, Config and Sync, Usage, Frustration, Agent Messages, Tuning and Help.',
    open: 'Under the Fleet in the sidebar.',
  },
  {
    name: 'Session Properties',
    area: 3,
    what: 'What the selected session is working on, its model, state, worktree and more.',
    open: 'At the bottom of the sidebar. It follows the Claude Code tab you are on.',
  },
  {
    name: 'Fleet title buttons',
    area: 4,
    what: 'New Claude Code session (the sparkle), Launcher, Fleet (full view), All Sessions and Refresh.',
    open: 'The top of the Fleet.',
  },
  {
    name: 'Info button',
    area: 5,
    what: 'Opens Session Properties beside the tab.',
    open: 'The title bar of a Claude Code tab.',
  },
  {
    name: 'Claude Code tab',
    area: 6,
    what: 'A terminal tab running claude attach, where you talk to the session.',
    open: "The sparkle, Continue in All Sessions, or clicking a background session's Fleet row.",
  },
  {
    name: 'Agent view',
    area: 6,
    what: 'An editor tab with the live feed of thinking and tool calls, a tool timeline and charts for one session or subagent.',
    open: 'The Agent view button on a Fleet row. Clicking the row of a Launcher run, or of any session with no tab, opens it too.',
  },
  {
    name: 'Launcher',
    area: 6,
    what: 'An editor tab that runs one prompt across several profiles, with the permission inbox and the Runs and Worktrees tables.',
    open: 'The rocket button on the Fleet.',
  },
  {
    name: 'Other pages',
    area: 6,
    what: 'Fleet (full view), All Sessions, Context Inspector, Knobs, Usage, this help and the rest, each an editor tab.',
    open: 'The Fleet title buttons, a Fleet row, or the Global list.',
  },
  {
    name: 'Notifications',
    area: 11,
    what: 'Progress, warnings and the questions Overlord asks before it acts.',
    open: 'They pop up in the bottom right corner.',
  },
  {
    name: 'Status bar item',
    area: 12,
    what: 'Running and waiting counts, spend per hour and the 5 hour limit.',
    open: 'The bottom of the window. Click it to open the Fleet.',
  },
];
