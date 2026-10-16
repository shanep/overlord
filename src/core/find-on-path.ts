// Find a program on PATH the way a shell would, so the launcher can hand the
// Agent SDK the user's installed claude binary.

import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

export interface FindOnPathInput {
  readonly name: string;
  readonly pathValue: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly isExecutable?: (file: string) => boolean;
}

export function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) {
      return false;
    }
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The absolute path of the first match, or null. Names with a directory part are returned as is. */
export function findOnPath(input: FindOnPathInput): string | null {
  const { name, platform } = input;
  if (name.includes('/') || name.includes('\\')) {
    return name;
  }
  const check = input.isExecutable ?? isExecutableFile;
  const separator = platform === 'win32' ? ';' : ':';
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const dirs = (input.pathValue ?? '').split(separator).filter((dir) => dir !== '');
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      if (check(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
