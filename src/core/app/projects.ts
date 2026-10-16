// Keeps each session's project current for the fleet. Git runs once per new
// session folder. A folder that turned out not to be a repository is checked
// again now and then, so a later `git init` takes effect without a reload.
// The hand made projects live in projects.json, which every window shares,
// along with every repository a session has run in, so a project can still
// be opened once its sessions are gone.

import type { ProjectSummary, SessionProject } from '../../shared/protocol.js';
import type { ProjectBook } from '../projects/book.js';
import { EMPTY_BOOK, projectSummaries, rememberRepos, resolveProject } from '../projects/book.js';
import type { WorktreeRegistry } from '../worktrees/registry.js';

import { messageOf } from './errors.js';
import { readProjects, storagePath, writeProjects } from './storage.js';

export interface ProjectsDeps {
  /** Where the hand made projects are kept. */
  readonly file: string;
  /** The repository folder a session folder maps to, for worktrees whose folder is gone. */
  readonly projectFor: (cwd: string) => string;
  /** The main checkout of the repository cwd is in, or null when there is none. */
  readonly repoRoot: (cwd: string) => Promise<string | null>;
  readonly clock: () => number;
  readonly onChange: () => void;
  readonly report: (source: string, message: string) => void;
}

/** How often session folders are matched to projects, and unplaced sessions asked about. */
export const PROJECTS_REFRESH_MS = 5000;
/** How long a folder that is not a repository waits before git looks at it again. */
export const RECHECK_MS = 60_000;
const SOURCE = 'projects';

interface RootCheck {
  readonly root: string | null;
  readonly checkedAt: number;
}

export interface ProjectView {
  readonly projects: readonly ProjectSummary[];
  readonly sessionProjects: Readonly<Record<string, SessionProject>>;
}

export interface SessionFolder {
  readonly id: string;
  readonly cwd: string;
}

function afterFailure(): void {
  // The caller of the failed change hears about it. The next change still runs.
}

export class ProjectIndex {
  private current: ProjectBook = EMPTY_BOOK;
  private readonly roots = new Map<string, RootCheck>();
  private readonly checking = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  /** Folders this window already asked about, so each is asked about once. */
  readonly asked = new Set<string>();

  constructor(private readonly deps: ProjectsDeps) {}

  /** Where the hand made projects are kept, which other windows change too. */
  get file(): string {
    return this.deps.file;
  }

  get book(): ProjectBook {
    return this.current;
  }

  /** The main checkout for cwd, null when it has none, or undefined before git has looked. */
  rootOf(cwd: string): string | null | undefined {
    return this.roots.get(cwd)?.root;
  }

  /** The project for a session folder, or null while it has not been checked. */
  resolve(cwd: string): SessionProject | null {
    const root = this.rootOf(cwd);
    return root === undefined ? null : resolveProject(this.current, cwd, root);
  }

  /** Projects and each checked session's project, for the fleet. */
  view(sessions: readonly SessionFolder[]): ProjectView {
    const sessionProjects: Record<string, SessionProject> = {};
    const roots: string[] = [];
    for (const session of sessions) {
      const found = this.resolve(session.cwd);
      if (found !== null) {
        sessionProjects[session.id] = found;
      }
      const root = this.rootOf(session.cwd);
      if (root !== undefined && root !== null) {
        roots.push(root);
      }
    }
    return { projects: projectSummaries(this.current, roots), sessionProjects };
  }

  /** Read projects.json again, which another window may have changed. */
  async load(): Promise<void> {
    try {
      const next = await readProjects(this.deps.file);
      if (JSON.stringify(next) !== JSON.stringify(this.current)) {
        this.current = next;
        this.deps.onChange();
      }
    } catch (error: unknown) {
      this.deps.report(SOURCE, messageOf(error));
    }
  }

  /**
   * Change the projects, starting from what is on disk so another window's
   * change survives. Changes run one at a time, so two at once both land.
   */
  async update(change: (book: ProjectBook) => ProjectBook): Promise<void> {
    const run = this.writes.then(async () => this.write(change));
    this.writes = run.catch(afterFailure);
    return run;
  }

  private async write(change: (book: ProjectBook) => ProjectBook): Promise<void> {
    const next = change(await readProjects(this.deps.file));
    await writeProjects(this.deps.file, next);
    this.current = next;
    this.deps.onChange();
  }

  /** Look up the folders git has not seen yet, or not lately when they were not repositories. */
  async refresh(cwds: readonly string[]): Promise<void> {
    const now = this.deps.clock();
    const due = [...new Set(cwds)].filter((cwd) => {
      if (cwd === '' || this.checking.has(cwd)) {
        return false;
      }
      const known = this.roots.get(cwd);
      return known === undefined || (known.root === null && now - known.checkedAt >= RECHECK_MS);
    });
    if (due.length === 0) {
      return;
    }
    for (const cwd of due) {
      this.checking.add(cwd);
    }
    const found = await Promise.all(due.map(async (cwd) => ({ cwd, root: await this.check(cwd) })));
    let changed = false;
    for (const { cwd, root } of found) {
      changed ||= this.roots.get(cwd)?.root !== root;
      this.roots.set(cwd, { root, checkedAt: now });
      this.checking.delete(cwd);
    }
    const roots = found.flatMap(({ root }) => (root === null ? [] : [root]));
    if (await this.remember(roots)) {
      return;
    }
    if (changed) {
      this.deps.onChange();
    }
  }

  /**
   * Keep repositories not yet in the book. True when the book changed, which
   * already told the panels.
   */
  private async remember(roots: readonly string[]): Promise<boolean> {
    if (rememberRepos(this.current, roots) === this.current) {
      return false;
    }
    try {
      await this.update((book) => rememberRepos(book, roots));
      return true;
    } catch (error: unknown) {
      this.deps.report(SOURCE, messageOf(error));
      return false;
    }
  }

  /**
   * A worktree maps back to its repository through the worktree registry,
   * even once its folder is gone. Any other folder asks git.
   */
  private async check(cwd: string): Promise<string | null> {
    const mapped = this.deps.projectFor(cwd);
    if (mapped !== cwd) {
      return mapped;
    }
    try {
      return await this.deps.repoRoot(cwd);
    } catch (error: unknown) {
      this.deps.report(SOURCE, messageOf(error));
      return null;
    }
  }
}

export interface ProjectEvents {
  readonly clock: () => number;
  readonly onChange: () => void;
  readonly report: (source: string, message: string) => void;
}

/** The index the app uses: projects.json in the storage folder, and the worktree registry for repositories. */
export function createProjectIndex(
  storageDir: string,
  worktrees: Pick<WorktreeRegistry, 'projectFor' | 'repoRoot'>,
  events: ProjectEvents,
): ProjectIndex {
  return new ProjectIndex({
    ...events,
    file: storagePath(storageDir, 'projects'),
    projectFor: worktrees.projectFor,
    repoRoot: async (cwd): Promise<string | null> => worktrees.repoRoot(cwd),
  });
}
