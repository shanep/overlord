import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ProjectsDeps } from './projects.js';
import { ProjectIndex, RECHECK_MS } from './projects.js';
import { readProjects, writeProjects } from './storage.js';
import { makeEnv, NOW, writeText } from './test-helpers/fixtures.js';

interface Harness {
  readonly index: ProjectIndex;
  readonly file: string;
  readonly onChange: ReturnType<typeof vi.fn>;
  readonly report: ReturnType<typeof vi.fn>;
  readonly looked: string[];
  readonly clock: { now: number };
}

const REPOS: Readonly<Record<string, string>> = { '/repo': '/repo', '/repo/src': '/repo' };

async function harness(overrides: Partial<ProjectsDeps> = {}): Promise<Harness> {
  const env = await makeEnv();
  const file = path.join(env.storageDir, 'projects.json');
  const onChange = vi.fn();
  const report = vi.fn();
  const looked: string[] = [];
  const clock = { now: NOW };
  const index = new ProjectIndex({
    file,
    projectFor: (cwd): string => (cwd.startsWith('/wt/') ? '/repo' : cwd),
    repoRoot: async (cwd): Promise<string | null> => {
      looked.push(cwd);
      await Promise.resolve();
      return REPOS[cwd] ?? null;
    },
    clock: (): number => clock.now,
    onChange,
    report,
    ...overrides,
  });
  return { index, file, onChange, report, looked, clock };
}

describe('ProjectIndex', () => {
  it('knows nothing about a folder until git has looked at it', async () => {
    const { index, onChange } = await harness();
    expect(index.rootOf('/repo')).toBeUndefined();
    expect(index.resolve('/repo')).toBeNull();
    expect(index.view([{ id: 's1', cwd: '/repo' }])).toStrictEqual({
      projects: [],
      sessionProjects: {},
    });
    await index.refresh(['/repo/src', '/notes', '']);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(index.rootOf('/repo/src')).toBe('/repo');
    expect(index.rootOf('/notes')).toBeNull();
    expect(index.rootOf('')).toBeUndefined();
    expect(
      index.view([
        { id: 's1', cwd: '/repo/src' },
        { id: 's2', cwd: '/notes' },
        { id: 's3', cwd: '/unseen' },
      ]),
    ).toStrictEqual({
      projects: [{ id: 'git:/repo', name: 'repo', kind: 'git', folder: '/repo' }],
      sessionProjects: {
        s1: { projectId: 'git:/repo', folder: '/repo', ignored: false },
        s2: { projectId: null, folder: '/notes', ignored: false },
      },
    });
  });

  it('maps a worktree through the registry without asking git', async () => {
    const { index, looked } = await harness();
    await index.refresh(['/wt/gone']);
    expect(looked).toStrictEqual([]);
    expect(index.rootOf('/wt/gone')).toBe('/repo');
  });

  it('asks git once per repository and again about other folders only after a while', async () => {
    const { index, looked, clock, onChange } = await harness();
    await index.refresh(['/repo', '/notes']);
    await index.refresh(['/repo', '/notes']);
    expect(looked).toStrictEqual(['/repo', '/notes']);
    clock.now += RECHECK_MS;
    await index.refresh(['/repo', '/notes']);
    expect(looked).toStrictEqual(['/repo', '/notes', '/notes']);
    // Nothing changed on the second look, so panels are not told twice.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not look at a folder twice while a look is under way', async () => {
    const { index, looked } = await harness();
    await Promise.all([index.refresh(['/repo']), index.refresh(['/repo'])]);
    expect(looked).toStrictEqual(['/repo']);
  });

  it('reports a git failure and treats the folder as no repository', async () => {
    const { index, report } = await harness({
      repoRoot: async () => {
        await Promise.resolve();
        throw new Error('git broke');
      },
    });
    await index.refresh(['/repo']);
    expect(report).toHaveBeenCalledWith('projects', 'git broke');
    expect(index.rootOf('/repo')).toBeNull();
  });

  it('loads the book, tells panels only when it changed, and reports a bad file', async () => {
    const { index, file, onChange, report } = await harness();
    await index.load();
    expect(onChange).not.toHaveBeenCalled();
    const book = { projects: [{ id: 'p1', name: 'Course' }], rules: [] };
    await writeProjects(file, book);
    await index.load();
    await index.load();
    expect(index.book).toStrictEqual(book);
    expect(onChange).toHaveBeenCalledTimes(1);
    await writeText(file, '{');
    await index.load();
    expect(report).toHaveBeenCalledWith('projects', `${file} is not valid JSON`);
    expect(index.book).toStrictEqual(book);
  });

  it('changes the book on disk, keeping what another window wrote', async () => {
    const { index, file, onChange } = await harness();
    await writeProjects(file, { projects: [{ id: 'p1', name: 'One' }], rules: [] });
    await index.update((book) => ({
      projects: [...book.projects, { id: 'p2', name: 'Two' }],
      rules: book.rules,
    }));
    const expected = {
      projects: [
        { id: 'p1', name: 'One' },
        { id: 'p2', name: 'Two' },
      ],
      rules: [],
    };
    expect(await readProjects(file)).toStrictEqual(expected);
    expect(index.book).toStrictEqual(expected);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('runs changes one at a time, and a failed one does not block the next', async () => {
    const { index, file } = await harness();
    await writeText(file, '{');
    await expect(index.update((book) => book)).rejects.toThrow('not valid JSON');
    await writeProjects(file, { projects: [], rules: [] });
    await Promise.all(
      ['p1', 'p2'].map(async (id) =>
        index.update((book) => ({
          projects: [...book.projects, { id, name: id }],
          rules: book.rules,
        })),
      ),
    );
    const { projects } = await readProjects(file);
    expect(projects.map((item) => item.id)).toStrictEqual(['p1', 'p2']);
  });
});
