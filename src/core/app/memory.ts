// Auto memory sync between ~/.claude/projects/<project>/memory and the config
// repo, keyed by git remote. The user chose it on for every project, so it
// runs with every push, pull and bootstrap when the manifest allows it.

import path from 'node:path';

import { encodeProjectDir } from '../paths.js';
import { backupDirName } from '../sync/apply.js';
import { readJsonOrUndefined } from '../sync/files.js';
import { isRecord } from '../sync/json.js';
import { readManifest } from '../sync/manifest.js';
import type { MemoryProject, MemorySyncResult } from '../sync/memory-sync.js';
import { syncMemory } from '../sync/memory-sync.js';

import type { Runtime } from './runtime.js';
import { storagePath } from './storage.js';
import { plural } from './text.js';

/** Projects Claude Code knows (from ~/.claude.json) plus every session cwd in the store. */
export async function memoryProjects(rt: Runtime): Promise<readonly MemoryProject[]> {
  const data = await readJsonOrUndefined(rt.paths.claudeJson);
  const projects = isRecord(data) ? data['projects'] : undefined;
  const cwds = [
    ...(isRecord(projects) ? Object.keys(projects) : []),
    ...rt.store.fleetState(rt.clock()).sessions.map((session) => session.cwd),
  ].filter((cwd) => cwd !== '');
  const byDir = new Map<string, MemoryProject>();
  for (const cwd of cwds) {
    const projectDir = path.join(rt.paths.projectsDir, encodeProjectDir(cwd));
    if (!byDir.has(projectDir)) {
      byDir.set(projectDir, { projectDir, cwd });
    }
  }
  return [...byDir.values()];
}

/** Runs memory sync when the manifest turns it on. Null when it is off or there is no manifest. */
export async function runMemorySync(
  rt: Runtime,
  repoRoot: string,
): Promise<MemorySyncResult | null> {
  const manifest = await readManifest(repoRoot);
  if (!manifest.ok || !manifest.manifest.memory.enabled) {
    return null;
  }
  const result = await syncMemory({
    projects: await memoryProjects(rt),
    repoRoot,
    exec: rt.exec,
    statePath: storagePath(rt.host.storageDir, 'memoryState'),
    backupDir: path.join(
      rt.paths.configDir,
      'backups',
      `${backupDirName(new Date(rt.clock()))}-memory`,
    ),
  });
  const blocked = result.synced.reduce((total, project) => total + project.blocked.length, 0);
  if (blocked > 0) {
    rt.host.showWarning(
      `Kept ${plural(blocked, 'memory file')} out of the repo because they look like they hold secrets.`,
    );
  }
  return result;
}
