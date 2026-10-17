// The small JSON files Overlord keeps in the extension's storage folder:
// auto-approve rules, prompt drafts, projects, launched sessions, token
// budgets and the claude.ai import. Every file is checked with zod on read,
// so a hand edit gone wrong is an error, not a crash.

import path from 'node:path';

import { z } from 'zod';

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { LauncherState, SurfaceSession } from '../../shared/protocol.js';
import type { AutoApproveRule } from '../../shared/rules.js';
import { readOptional, writeFileAtomic } from '../knobs/atomic-file.js';
import type { ProjectBook } from '../projects/book.js';

export type Draft = LauncherState['drafts'][number];

export interface StoredImport {
  readonly importedAt: number;
  readonly sessions: readonly SurfaceSession[];
}

export type StorageName =
  | 'rules'
  | 'audit'
  | 'profiles'
  | 'drafts'
  | 'claudeAi'
  | 'memoryState'
  | 'dryRun'
  | 'projects'
  | 'launched'
  | 'budgets';

export const STORAGE_FILES: Readonly<Record<StorageName, string>> = {
  rules: 'rules.json',
  audit: 'audit.jsonl',
  profiles: 'profiles.json',
  drafts: 'drafts.json',
  claudeAi: 'claude-ai.json',
  memoryState: 'memory-state.json',
  dryRun: 'dry-run.txt',
  projects: 'projects.json',
  launched: 'launched.json',
  budgets: 'budgets.json',
};

export function storagePath(storageDir: string, name: StorageName): string {
  return path.join(storageDir, STORAGE_FILES[name]);
}

const ruleSchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean(),
    behavior: z.enum(['allow', 'deny']),
    tool: z.string().min(1),
    pattern: z.string().nullable(),
    description: z.string(),
    agent: z.string().min(1).optional(),
  })
  // A rule with no agent keeps the key out, so it reads as an old Claude Code rule.
  .transform(({ agent, ...rule }): AutoApproveRule =>
    agent === undefined ? rule : { ...rule, agent },
  );

/** The rule when the value is a valid AutoApproveRule, else null. */
export function parseRule(value: unknown): AutoApproveRule | null {
  const parsed = ruleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const rulesFileSchema = z.object({ version: z.literal(1), rules: z.array(ruleSchema) });

const draftsFileSchema = z.object({
  version: z.literal(1),
  drafts: z.array(z.object({ id: z.string(), label: z.string(), prompt: z.string() })),
});

const importFileSchema = z.object({
  version: z.literal(1),
  importedAt: z.number(),
  sessions: z.array(z.object({ id: z.string().min(1), title: z.string(), updatedAt: z.number() })),
});

const projectsFileSchema = z.object({
  version: z.literal(1),
  projects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      folder: z.string().min(1).nullable().default(null),
    }),
  ),
  rules: z.array(z.object({ folder: z.string().min(1), projectId: z.string().min(1).nullable() })),
  repos: z.array(z.string().min(1)).default([]),
});

const launchedFileSchema = z.object({
  version: z.literal(1),
  sessions: z.array(z.string().min(1)),
});

const budgetSchema = z.object({
  tokens: z.number().positive(),
  warned: z.boolean(),
});

const budgetsFileSchema = z.object({
  version: z.literal(1),
  budgets: z.record(z.string().min(1), budgetSchema),
});

/** A token budget set on a session, and whether its warning has been shown. */
export type StoredBudget = z.infer<typeof budgetSchema>;

/** Parsed file contents, or `fallback` when the file does not exist. */
async function readChecked<T>(file: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  const text = await readOptional(file);
  if (text === null) {
    return fallback;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file} is not in the expected format`);
  }
  return parsed.data;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic({
    target: file,
    content: `${JSON.stringify(value, null, 2)}\n`,
    backup: null,
  });
}

export async function readRules(file: string): Promise<readonly AutoApproveRule[]> {
  const data = await readChecked(file, rulesFileSchema, { version: 1, rules: [] });
  return data.rules;
}

export async function writeRules(file: string, rules: readonly AutoApproveRule[]): Promise<void> {
  await writeJson(file, { version: 1, rules });
}

export async function readDrafts(file: string): Promise<readonly Draft[]> {
  const data = await readChecked(file, draftsFileSchema, { version: 1, drafts: [] });
  return data.drafts;
}

/** Only titles and times are kept, never message text. */
export async function readImport(file: string): Promise<StoredImport | null> {
  const data = await readChecked(file, importFileSchema.nullable(), null);
  if (data === null) {
    return null;
  }
  return {
    importedAt: data.importedAt,
    sessions: data.sessions.map((session): SurfaceSession => ({
      ...session,
      agent: CLAUDE_CODE,
      surface: 'claude-ai',
      cwd: null,
      archived: false,
      handoffs: [],
    })),
  };
}

export async function writeImport(file: string, stored: StoredImport): Promise<void> {
  await writeJson(file, {
    version: 1,
    importedAt: stored.importedAt,
    sessions: stored.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
    })),
  });
}

export async function readProjects(file: string): Promise<ProjectBook> {
  const data = await readChecked(file, projectsFileSchema, {
    version: 1,
    projects: [],
    rules: [],
    repos: [],
  });
  return { projects: data.projects, rules: data.rules, repos: data.repos };
}

export async function writeProjects(file: string, book: ProjectBook): Promise<void> {
  await writeJson(file, {
    version: 1,
    projects: book.projects,
    rules: book.rules,
    repos: book.repos,
  });
}

/** The ids of the sessions the Launcher started that are still in the fleet. */
export async function readLaunched(file: string): Promise<readonly string[]> {
  const data = await readChecked(file, launchedFileSchema, { version: 1, sessions: [] });
  return data.sessions;
}

export async function writeLaunched(file: string, sessions: readonly string[]): Promise<void> {
  await writeJson(file, { version: 1, sessions });
}

/** The token budgets set on sessions, by session id. */
export async function readBudgets(file: string): Promise<Readonly<Record<string, StoredBudget>>> {
  const data = await readChecked(file, budgetsFileSchema, { version: 1, budgets: {} });
  return data.budgets;
}

export async function writeBudgets(
  file: string,
  budgets: Readonly<Record<string, StoredBudget>>,
): Promise<void> {
  await writeJson(file, { version: 1, budgets });
}
