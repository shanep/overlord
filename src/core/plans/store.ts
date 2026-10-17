// Saved plans: one JSON file in the extension's storage folder, so a plan and
// how far it got survive a reload. A file Overlord cannot read starts empty.

import { z } from 'zod';

import type { Plan } from '../../shared/plans.js';
import { readOptional, writeFileAtomic } from '../knobs/atomic-file.js';

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  dependsOn: z.array(z.string()).readonly(),
  files: z.array(z.string()).readonly(),
  state: z.enum(['waiting', 'queued', 'running', 'landed', 'failed', 'stopped']),
  runId: z.string().nullable(),
  sessionId: z.string().nullable(),
  landedSha: z.string().nullable(),
  note: z.string().nullable(),
});

const planSchema = z.object({
  id: z.string(),
  goal: z.string(),
  cwd: z.string(),
  createdAt: z.number(),
  state: z.enum(['drafting', 'draft', 'running', 'done', 'stopped', 'failed']),
  summary: z.string(),
  tasks: z.array(taskSchema).readonly(),
  error: z.string().nullable(),
}) satisfies z.ZodType<Plan>;

const fileSchema = z.object({ version: z.literal(1), plans: z.array(planSchema) });

export async function loadPlans(file: string): Promise<Plan[]> {
  const text = await readOptional(file);
  if (text === null) {
    return [];
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.plans : [];
  } catch {
    return [];
  }
}

export async function savePlans(file: string, plans: readonly Plan[]): Promise<void> {
  await writeFileAtomic({
    target: file,
    content: `${JSON.stringify({ version: 1, plans }, null, 2)}\n`,
    backup: null,
  });
}
