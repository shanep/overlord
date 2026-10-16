// Works out the badge for a file on disk: in the config repo (clean or
// modified), in some other git repo, or not versioned anywhere. Git
// remotes are cached per repo, since an inventory asks many times.

import type { ConfigItem, ConfigStatus } from '../../shared/model.js';

import type { Exec } from './exec.js';
import { isInside, lstatOrNull, realpathOrSelf } from './files.js';
import { isDirty, isIgnored, remoteUrl, repoRootOf } from './git.js';

type RepoInfo = NonNullable<ConfigItem['repo']>;

export interface PathStatus {
  readonly status: ConfigStatus;
  /** Symlink target, when the path itself is a link. */
  readonly realPath: string | null;
  readonly repo: ConfigItem['repo'];
}

export interface StatusResolver {
  readonly resolve: (target: string) => Promise<PathStatus>;
  readonly configRoot: string | null;
}

export async function createStatusResolver(
  exec: Exec,
  configRepoRoot: string | null,
): Promise<StatusResolver> {
  const configRoot = configRepoRoot === null ? null : await realpathOrSelf(configRepoRoot);
  const remotes = new Map<string, string | null>();
  const remoteFor = async (root: string): Promise<string | null> => {
    const known = remotes.get(root);
    if (known !== undefined) {
      return known;
    }
    const url = await remoteUrl(exec, root);
    remotes.set(root, url);
    return url;
  };

  const inRepo = async (root: string, target: string): Promise<RepoInfo> => ({
    root,
    remote: await remoteFor(root),
    dirty: await isDirty(exec, root, target),
  });

  const resolve = async (target: string): Promise<PathStatus> => {
    const link = await lstatOrNull(target);
    const realPath = link?.isSymbolicLink() === true ? await realpathOrSelf(target) : null;
    const resolved = await realpathOrSelf(target);
    if (configRoot !== null && isInside(resolved, configRoot)) {
      const repo = await inRepo(configRoot, resolved);
      return { status: repo.dirty ? 'modified' : 'versioned', realPath, repo };
    }
    const root = await repoRootOf(exec, resolved);
    if (root === null || (await isIgnored(exec, root, resolved))) {
      return { status: 'local-only', realPath, repo: null };
    }
    return { status: 'external-repo', realPath, repo: await inRepo(root, resolved) };
  };

  return { resolve, configRoot };
}
