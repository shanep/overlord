// A throwaway HOME for tests, with ClaudePaths pointing into it.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveClaudePaths } from '../../paths.js';
import type { ClaudePaths } from '../../paths.js';

export interface ScratchHome {
  readonly root: string;
  readonly paths: ClaudePaths;
  writeText: (relative: string, text: string) => Promise<string>;
  writeJson: (relative: string, data: unknown) => Promise<string>;
  makeDir: (relative: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

export async function makeScratchHome(platform: NodeJS.Platform = 'darwin'): Promise<ScratchHome> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'overlord-surfaces-'));
  const writeText = async (relative: string, text: string): Promise<string> => {
    const full = path.join(root, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text, 'utf8');
    return full;
  };
  return {
    root,
    paths: resolveClaudePaths({ home: root, platform, env: {} }),
    writeText,
    writeJson: async (relative, data): Promise<string> => writeText(relative, JSON.stringify(data)),
    makeDir: async (relative): Promise<string> => {
      const full = path.join(root, relative);
      await mkdir(full, { recursive: true });
      return full;
    },
    cleanup: async (): Promise<void> => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export const DESKTOP = 'Library/Application Support/Claude';
