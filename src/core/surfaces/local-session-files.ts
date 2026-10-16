// Claude Desktop keeps one JSON file per session at
// <root>/<account id>/<org id>/local_<id>.json for both the Code tab and
// Cowork. Other files sit next to them (scheduled-tasks.json, .claude.json)
// and are skipped.

import path from 'node:path';

import type { z } from 'zod';

import { readDirOrEmpty, readJsonFile, sourceError } from './common.js';
import type { Collected, SourceError } from './common.js';

const SESSION_FILE = /^local_[^/]+\.json$/u;

export function isSessionFileName(name: string): boolean {
  return SESSION_FILE.test(name);
}

async function childDirs(dir: string): Promise<string[]> {
  const entries = await readDirOrEmpty(dir);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
}

/** Every local_*.json two levels under root. A missing root yields nothing. */
export async function listSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const account of await childDirs(root)) {
    for (const org of await childDirs(account)) {
      const entries = await readDirOrEmpty(org);
      for (const entry of entries) {
        if (entry.isFile() && isSessionFileName(entry.name)) {
          files.push(path.join(org, entry.name));
        }
      }
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

export interface ParsedFile<T> {
  readonly filePath: string;
  readonly data: T;
}

/** Read and validate every session file under root, collecting failures per file. */
export async function readSessionFiles<T>(
  root: string,
  schema: z.ZodType<T>,
  source: string,
): Promise<Collected<ParsedFile<T>>> {
  const items: ParsedFile<T>[] = [];
  const errors: SourceError[] = [];
  let files: string[];
  try {
    files = await listSessionFiles(root);
  } catch (error) {
    return { items, errors: [sourceError(source, error, root)] };
  }
  for (const filePath of files) {
    try {
      items.push({ filePath, data: await readJsonFile(filePath, schema) });
    } catch (error) {
      errors.push(sourceError(source, error, filePath));
    }
  }
  return { items, errors };
}
