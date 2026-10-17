// Drafts a plan: a fresh Claude session reads the repository and splits the
// goal into tasks for separate sessions, with what each depends on and the
// files it will likely change. Tasks that would change the same files are
// ordered one after the other, so parallel sessions do not clash.

import { z } from 'zod';

import type { Exec } from '../sync/exec.js';

const DRAFT_TIMEOUT_MS = 20 * 60_000;
const MAX_TASKS = 12;

const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
});

const draftSchema = z.object({
  summary: z.string().default(''),
  tasks: z.array(taskSchema).min(1).max(MAX_TASKS),
});

type DraftTask = z.infer<typeof taskSchema>;

export interface Draft {
  readonly summary: string;
  readonly tasks: readonly DraftTask[];
}

/** The JSON Schema the planner answers in. */
const DRAFT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_TASKS,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'prompt', 'dependsOn', 'files'],
      },
    },
  },
  required: ['summary', 'tasks'],
} as const;

export function draftPrompt(goal: string): string {
  return `Split this goal into tasks for separate Claude Code sessions. Each session works in its own git worktree of this repository, at the same time as the others, and lands its own work on the default branch when it is done.

Goal: ${goal}

Read the repository first (Read, Grep, Glob) so the tasks fit how it is built. Do not edit anything.

Rules for the tasks:
- Each task is something one session can finish, check and land on its own, in about an hour. Use as few tasks as the goal needs, at most ${String(MAX_TASKS)}. One task is fine for a small goal.
- Write each prompt so it stands on its own: the session sees only its prompt, not the goal or the other tasks. Name the files, functions and behavior involved, and say what done looks like, including the tests.
- dependsOn lists the ids of tasks that must land first: because this task builds on their code, or because both would change the same files. Tasks with no dependency between them run in parallel, so only add one when it is needed.
- files lists the files the task will likely change.
- Ids are short lowercase words with hyphens, unique in the plan.

summary is one short paragraph on how you split the work and why.`;
}

/**
 * Drops duplicate ids and unknown or self dependencies, breaks any loop by
 * dropping the dependency that closes it, and orders the tasks so each comes
 * after the ones it depends on.
 */
export function tidy(draft: Draft): Draft {
  const seen = new Set<string>();
  const tasks = draft.tasks.filter((task) => {
    const fresh = !seen.has(task.id);
    seen.add(task.id);
    return fresh;
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ordered: DraftTask[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (task: DraftTask): void => {
    visiting.add(task.id);
    const dependsOn: string[] = [];
    for (const id of new Set(task.dependsOn)) {
      const dependency = byId.get(id);
      // Unknown, itself, or a loop back to a task still being visited.
      if (dependency === undefined || visiting.has(id)) {
        continue;
      }
      if (!done.has(id)) {
        visit(dependency);
      }
      dependsOn.push(id);
    }
    visiting.delete(task.id);
    done.add(task.id);
    ordered.push({ ...task, dependsOn });
  };
  for (const task of tasks) {
    if (!done.has(task.id)) {
      visit(task);
    }
  }
  return { summary: draft.summary, tasks: ordered };
}

/** The plan in the planner's answer, from structured output or the text of the answer. */
export function parseDraft(stdout: string): Draft {
  const outer = z
    .object({ structured_output: z.unknown().optional(), result: z.string().optional() })
    .parse(JSON.parse(stdout));
  let value = outer.structured_output;
  if (value === undefined) {
    const text = outer.result ?? '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error('The planner did not answer with a plan.');
    }
    value = JSON.parse(text.slice(start, end + 1));
  }
  return tidy(draftSchema.parse(value));
}

export interface DraftOptions {
  readonly exec: Exec;
  readonly claude: string;
  readonly cwd: string;
  readonly goal: string;
}

export async function draftPlan(options: DraftOptions): Promise<Draft> {
  const result = await options.exec(
    options.claude,
    [
      '-p',
      draftPrompt(options.goal),
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(DRAFT_JSON_SCHEMA),
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      '--disallowedTools',
      'Edit',
      'Write',
      'Bash',
      'NotebookEdit',
      '--no-session-persistence',
    ],
    { cwd: options.cwd, timeoutMs: DRAFT_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    throw new Error(
      `The planner stopped with exit code ${String(result.code)}: ${result.stderr.trim().slice(0, 300)}`,
    );
  }
  return parseDraft(result.stdout);
}
