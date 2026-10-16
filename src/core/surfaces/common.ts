// Every reader in this directory reports failures as data so one broken
// source never hides the others.

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';

import { z } from 'zod';

export interface SourceError {
  /** Which source failed, for example "desktop" or "claude-agents". */
  readonly source: string;
  readonly message: string;
  /** The file involved, when there is one. */
  readonly path: string | null;
}

/** Items a reader could parse, plus what went wrong with the rest. */
export interface Collected<T> {
  readonly items: readonly T[];
  readonly errors: readonly SourceError[];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function sourceError(source: string, error: unknown, filePath: string | null): SourceError {
  return { source, message: errorMessage(error), path: filePath };
}

/** Read and validate a JSON file. Throws with a readable message on any failure. */
export async function readJsonFile<T>(filePath: string, schema: z.ZodType<T>): Promise<T> {
  const text = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(text);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `unexpected shape: ${result.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return result.data;
}

/** Directory entries, or an empty list when the directory does not exist. */
export async function readDirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
}

// Keep the entries that parse and drop the rest, instead of failing the list.
export function lenientArray<T>(schema: z.ZodType<T>): z.ZodType<T[]> {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((item) => {
        const result = schema.safeParse(item);
        return result.success ? [result.data] : [];
      }),
    );
}
