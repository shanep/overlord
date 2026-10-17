// workspace.yaml, the small metadata file beside each session's events.jsonl:
// id, cwd, git root, branch, the session's name and whether the user set it.

import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';
import { z } from 'zod';

const looseString = z.string().nullish().catch(null);

const workspaceSchema = z.object({
  cwd: looseString,
  branch: looseString,
  name: looseString,
  user_named: z.boolean().nullish().catch(null),
});

export interface Workspace {
  readonly cwd: string | null;
  readonly branch: string | null;
  /** The first prompt, or the name the user gave the session. */
  readonly name: string | null;
  readonly userNamed: boolean;
}

export const WORKSPACE_FILE = 'workspace.yaml';

/** The file's fields, or null when it is missing or is not a YAML map. */
export async function readWorkspace(file: string): Promise<Workspace | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    return null;
  }
  const parsed = workspaceSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  return {
    cwd: data.cwd ?? null,
    branch: data.branch ?? null,
    name: data.name ?? null,
    userNamed: data.user_named === true,
  };
}
