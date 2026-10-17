import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConfigItem } from '../../shared/model.js';
import { claudeCode } from '../agents/claude/index.js';
import { threeAgents } from '../agents/test-helpers/library-agents.js';
import type { LibraryPlace } from '../agents/types.js';
import { createNodeFileSystem } from '../context/fs.js';
import { resolveClaudePaths } from '../paths.js';

import type { LibraryReader } from './library.js';
import { libraryReaders, mergeLibrary, readersOf, scanLibrary } from './library.js';

let root = '';
let home = '';
let work = '';

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: Does ${name}.\n---\n\nSteps.\n`;
}

function place(env: Readonly<Record<string, string>> = {}): LibraryPlace {
  return {
    home,
    env,
    claude: resolveClaudePaths({ home, platform: 'linux', env: {} }),
    cwd: work,
    gitRoot: work,
    plugins: [],
  };
}

function everyone(): LibraryReader[] {
  return libraryReaders(threeAgents().list(), () => true);
}

function item(kind: 'skill' | 'agent', name: string, file: string): ConfigItem {
  return {
    id: `${kind}:${name}`,
    kind,
    name,
    scope: 'project',
    path: file,
    realPath: null,
    status: 'local-only',
    repo: null,
  };
}

describe('skill and agent library', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overlord-library-')));
    home = path.join(root, 'home');
    work = path.join(root, 'work');
    await mkdir(work, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('libraryReaders', () => {
    it('always has Claude Code and only the other agents in play', () => {
      const adapters = threeAgents().list();
      expect(libraryReaders(adapters, () => false).map((reader) => reader.id)).toStrictEqual([
        'claude-code',
      ]);
      expect(
        libraryReaders(adapters, (id) => id === 'codex').map((reader) => reader.id),
      ).toStrictEqual(['claude-code', 'codex']);
      // An adapter with no library facet is left out even when it is in play.
      const bare = { ...claudeCode, id: 'bare', config: { settingsFormat: 'json' as const } };
      expect(libraryReaders([bare], () => true)).toStrictEqual([]);
    });
  });

  describe('readersOf', () => {
    it('names every agent that reads a shared folder', () => {
      const readers = everyone();
      const shorts = (dir: string): string[] =>
        readersOf(readers, 'skill', place(), dir).map((reader) => reader.short);
      expect(shorts(path.join(work, '.claude', 'skills'))).toStrictEqual(['Claude', 'Copilot']);
      expect(shorts(path.join(work, '.agents', 'skills'))).toStrictEqual(['Copilot', 'Codex']);
      expect(shorts(path.join(home, '.agents', 'skills'))).toStrictEqual(['Copilot', 'Codex']);
      expect(shorts(path.join(home, '.claude', 'skills'))).toStrictEqual(['Claude']);
      expect(shorts(path.join(work, '.github', 'skills'))).toStrictEqual(['Copilot']);
    });
  });

  describe('scanLibrary and mergeLibrary', () => {
    it('lists a skill once with every agent that reads it and adds what Claude does not read', async () => {
      await put(path.join(work, '.agents', 'skills', 'triage', 'SKILL.md'), skill('triage'));
      await put(path.join(home, '.copilot', 'skills', 'mine', 'SKILL.md'), skill('mine'));
      await put(path.join(work, '.claude', 'skills', 'notes', 'SKILL.md'), skill('notes'));
      await put(path.join(work, '.github', 'skills', 'empty', 'README.md'), 'not a skill');
      const readers = everyone();
      const scan = readers.filter((reader) => reader.id !== 'claude-code');
      const found = await scanLibrary({
        fs: createNodeFileSystem(),
        kind: 'skill',
        place: place(),
        readers,
        scan,
      });
      expect(found.map((one) => [one.name, one.scope, one.readers])).toStrictEqual([
        ['triage', 'project', ['copilot', 'codex']],
        ['notes', 'project', ['claude-code', 'copilot']],
        ['mine', 'user', ['copilot']],
      ]);
      const notes = path.join(work, '.claude', 'skills', 'notes');
      const merged = mergeLibrary({
        kind: 'skill',
        installed: [item('skill', 'notes', notes)],
        found,
        readers,
        place: place(),
      });
      expect(merged.map((one) => [one.name, one.status, one.agents])).toStrictEqual([
        ['notes', 'local-only', ['Claude', 'Copilot']],
        ['triage', 'local-only', ['Copilot', 'Codex']],
        ['mine', 'local-only', ['Copilot']],
      ]);
    });

    it('leaves the inventory as it is with Claude Code alone', () => {
      const installed = [item('skill', 'notes', path.join(work, '.claude', 'skills', 'notes'))];
      const readers = libraryReaders(threeAgents().list(), () => false);
      const merged = mergeLibrary({ kind: 'skill', installed, found: [], readers, place: place() });
      expect(merged).toStrictEqual(installed);
    });

    it('finds Copilot and Codex agent files in their own folders and formats', async () => {
      await put(
        path.join(work, '.github', 'agents', 'reviewer.agent.md'),
        '---\nname: Reviewer\ndescription: Reviews.\n---\n\nReview.\n',
      );
      await put(
        path.join(home, '.codex', 'agents', 'explorer.toml'),
        'name = "pr_explorer"\ndescription = "Explores."\ndeveloper_instructions = "Look."\n',
      );
      await put(path.join(home, 'alt-codex', 'agents', 'moved.toml'), 'name = "moved"\n');
      await put(path.join(work, '.codex', 'agents', 'notes.txt'), 'not an agent');
      const readers = everyone();
      const scan = readers.filter((reader) => reader.id !== 'claude-code');
      const fs = createNodeFileSystem();
      const names = async (env: Readonly<Record<string, string>>): Promise<string[][]> => {
        const found = await scanLibrary({ fs, kind: 'agent', place: place(env), readers, scan });
        return found.map((one) => [one.name, one.scope, ...one.readers]);
      };
      expect(await names({})).toStrictEqual([
        ['reviewer', 'project', 'copilot'],
        ['pr_explorer', 'user', 'codex'],
      ]);
      expect(await names({ CODEX_HOME: path.join(home, 'alt-codex') })).toStrictEqual([
        ['reviewer', 'project', 'copilot'],
        ['moved', 'user', 'codex'],
      ]);
    });
  });
});
