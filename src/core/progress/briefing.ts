// The part of the note every new session gets that asks the agent to keep its
// task list whole, since the Fleet's progress and estimates come from it.

export const PROGRESS_RULE = [
  'Overlord progress. For any task with more than a few steps, put every step in your task list',
  '(TaskCreate or TodoWrite in Claude Code, update_plan in Codex) before you start: one entry per',
  'step or per subagent you plan to run, not one entry for a whole batch. Mark each one in progress',
  'when you start it and completed when it is done, and add steps as you find them. Overlord reads',
  'this list to show the user how far along you are and how many tokens and how much time are left.',
].join(' ');
