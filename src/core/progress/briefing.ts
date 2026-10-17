// The part of the note every new session gets that asks the agent to keep its
// task list whole, since the Fleet's progress and estimates come from it.

/**
 * The rule for an agent whose task list Overlord reads, naming its own tools
 * (TaskCreate or TodoWrite in Claude Code, update_plan in Codex). Subagents
 * get an entry each only for an agent that has them.
 */
export function progressRule(taskList: string, subagents: boolean): string {
  const entries = subagents
    ? 'one entry per step or per subagent you plan to run'
    : 'one entry per step';
  return [
    'Overlord progress. For any task with more than a few steps, put every step in your task list',
    `(${taskList}) before you start: ${entries}, not one entry for a whole batch. Mark each one in`,
    'progress when you start it and completed when it is done, and add steps as you find them.',
    'Overlord reads this list to show the user how far along you are and how many tokens and how',
    'much time are left.',
  ].join(' ');
}
