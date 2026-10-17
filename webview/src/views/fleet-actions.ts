// The buttons on Fleet rows: what each one is called and what its tooltip says.

export type RowAction =
  | 'open'
  | 'context'
  | 'interrupt'
  | 'stop'
  | 'remove'
  | 'renameSession'
  | 'move'
  | 'relocate'
  | 'combine';
/** A row button, the health bar, which opens Session Properties, or the progress bar, which sets a budget. */
export type RowEvent = RowAction | 'properties' | 'budget';
export type ProjectAction = 'newSession' | 'openFolder' | 'setFolder' | 'rename' | 'delete';

export const ACTION_LABELS: Readonly<Record<RowAction | ProjectAction, string>> = {
  open: 'Agent view',
  context: 'Context Inspector',
  interrupt: 'Interrupt',
  stop: 'Stop',
  remove: 'Remove from fleet',
  renameSession: 'Rename session',
  move: 'Move to project',
  relocate: 'Continue in folder',
  combine: 'Combine sessions',
  newSession: 'New session in project',
  openFolder: 'Open project folder',
  setFolder: 'Set project folder',
  rename: 'Rename project',
  delete: 'Delete project',
};

/** What each action button does, shown as its tooltip after the label. */
const ACTION_TIPS: Readonly<Record<RowAction | ProjectAction, string>> = {
  open: 'Open the transcript and controls for this session',
  context: 'See what fills the context window',
  interrupt: 'Stop the current turn, keep the session',
  stop: 'End the session',
  remove: 'Take this launched session out of the fleet, stopping it first if it still runs',
  renameSession: 'Give this session a new name',
  move: 'Put this session in another project',
  relocate: 'Continue a copy of this session in another folder',
  combine: 'Start one new session from a digest of this and others',
  newSession: 'Start a session in this project, in its own worktree',
  openFolder: 'Reveal the folder this project works in',
  setFolder: 'Pick the folder this project works in',
  rename: 'Give this project a new name',
  delete: 'Remove the project, its sessions stay',
};

/** The tip for a button. New session names the agent it starts when only one is on offer. */
export function actionTip(action: RowAction | ProjectAction, agentName: string | null): string {
  const tip =
    action === 'newSession' && agentName !== null
      ? `Start ${agentName} in this project, in its own worktree`
      : ACTION_TIPS[action];
  return `${ACTION_LABELS[action]}: ${tip}`;
}
