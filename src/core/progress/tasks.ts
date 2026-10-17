// Reads a session's task list from the calls its main thread made to its own
// task tools: Claude Code's TaskCreate and TaskUpdate, its older TodoWrite,
// and Codex's update_plan. The agent already keeps this list for itself, so
// the Fleet can show progress without asking the agent for anything more.

import { z } from 'zod';

import type { ToolCall } from '../../shared/model.js';
import type { TaskItem, TaskList, TaskStatus } from '../../shared/progress.js';

/** The tools whose calls carry the task list. */
export const TASK_TOOLS: ReadonlySet<string> = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TodoWrite',
  'update_plan',
]);

const status = z.enum(['pending', 'in_progress', 'completed']);

const createInput = z.object({ subject: z.string() });

const updateInput = z.object({
  taskId: z.string(),
  subject: z.string().optional(),
  status: z.union([status, z.literal('deleted')]).optional(),
});

const todoInput = z.object({
  todos: z.array(z.object({ content: z.string(), status })),
});

const planInput = z.object({
  plan: z.array(z.object({ step: z.string(), status })),
});

// TaskCreate answers "Task #3 created successfully: ...".
const CREATED_ID = /^Task #(\S+) created/u;

interface Builder {
  /** TaskCreate and TaskUpdate edit this list one task at a time. */
  readonly tasks: Map<string, TaskItem>;
  /** TodoWrite and update_plan send the whole list each time, so the latest one wins. */
  snapshot: readonly TaskItem[] | null;
  startedAt: number | null;
  /** The highest task number made so far, deleted ones included, since Claude Code never reuses one. */
  highest: number;
}

function createTask(builder: Builder, call: ToolCall): void {
  const input = createInput.safeParse(call.input);
  if (!input.success) {
    return;
  }
  const id = CREATED_ID.exec(call.resultPreview ?? '')?.[1] ?? String(builder.highest + 1);
  builder.highest = Math.max(builder.highest, Number(id) || 0);
  builder.tasks.set(id, { id, subject: input.data.subject, status: 'pending' });
}

function updateTask(builder: Builder, call: ToolCall): void {
  const input = updateInput.safeParse(call.input);
  const known = input.success ? builder.tasks.get(input.data.taskId) : undefined;
  if (!input.success || known === undefined) {
    return;
  }
  const next = input.data.status;
  if (next === 'deleted') {
    builder.tasks.delete(known.id);
    return;
  }
  builder.tasks.set(known.id, {
    id: known.id,
    subject: input.data.subject ?? known.subject,
    status: next ?? known.status,
  });
}

function listed(
  steps: readonly { readonly text: string; readonly status: TaskStatus }[],
): TaskItem[] {
  return steps.map((step, index) => ({
    id: String(index + 1),
    subject: step.text,
    status: step.status,
  }));
}

/** The whole list a TodoWrite or update_plan call sends, or null when the input is not one. */
function snapshotOf(call: ToolCall): readonly TaskItem[] | null {
  if (call.name === 'TodoWrite') {
    const input = todoInput.safeParse(call.input);
    return input.success
      ? listed(input.data.todos.map((todo) => ({ text: todo.content, status: todo.status })))
      : null;
  }
  const input = planInput.safeParse(call.input);
  return input.success
    ? listed(input.data.plan.map((step) => ({ text: step.step, status: step.status })))
    : null;
}

function apply(builder: Builder, call: ToolCall): void {
  if (call.name === 'TaskCreate') {
    createTask(builder, call);
  } else if (call.name === 'TaskUpdate') {
    updateTask(builder, call);
  } else {
    builder.snapshot = snapshotOf(call) ?? builder.snapshot;
  }
}

/**
 * The task list from a main thread's task tool calls, or null when it has
 * none. Calls are applied in start order, once each, since a resumed
 * transcript can repeat a call. A failed call changed nothing.
 */
export function readTaskList(calls: readonly ToolCall[]): TaskList | null {
  const builder: Builder = { tasks: new Map(), snapshot: null, startedAt: null, highest: 0 };
  const seen = new Set<string>();
  const ordered = calls
    .filter((call) => TASK_TOOLS.has(call.name) && call.ok !== false)
    .toSorted((left, right) => left.startedAt - right.startedAt);
  for (const call of ordered) {
    if (seen.has(call.id)) {
      continue;
    }
    seen.add(call.id);
    builder.startedAt ??= call.startedAt;
    apply(builder, call);
  }
  const items = builder.tasks.size > 0 ? [...builder.tasks.values()] : (builder.snapshot ?? []);
  if (builder.startedAt === null || items.length === 0) {
    return null;
  }
  return { items, startedAt: builder.startedAt };
}
