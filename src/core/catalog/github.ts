// Reads public GitHub repositories for the Skills and Agents views: one REST
// call lists every file in a repository, and the files themselves come from
// raw.githubusercontent.com, which does not count against the API's rate
// limit. Anonymous REST calls get 60 an hour, so the editor's GitHub sign-in
// is used when there is one, and each repository is listed once per window.

import { z } from 'zod';

import type { FetchFunction } from '../sync/github.js';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const TIMEOUT_MS = 15_000;

export interface RepoFile {
  readonly path: string;
  readonly size: number;
}

const treeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional() })),
});

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/u;

export function isRepo(value: string): boolean {
  return REPO_PATTERN.test(value) && !value.split('/').includes('..');
}

function encodePath(filePath: string): string {
  return filePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/** The page for a file or folder on github.com, at the default branch. */
export function githubUrl(repo: string, filePath: string, folder = false): string {
  return `https://github.com/${repo}/${folder ? 'tree' : 'blob'}/HEAD/${encodePath(filePath)}`;
}

export interface GitHubReaderDeps {
  readonly fetch: FetchFunction;
  /** A token from the editor's GitHub sign-in, or null to call anonymously. */
  readonly token: () => Promise<string | null>;
}

export class GitHubReader {
  private readonly trees = new Map<string, Promise<readonly RepoFile[]>>();
  private readonly deps: GitHubReaderDeps;

  constructor(deps: GitHubReaderDeps) {
    this.deps = deps;
  }

  /** Every file in the repository at its default branch. A failed listing is tried again next time. */
  async files(repo: string): Promise<readonly RepoFile[]> {
    const known = this.trees.get(repo);
    if (known !== undefined) {
      return known;
    }
    const listing = this.list(repo);
    this.trees.set(repo, listing);
    listing.catch(() => {
      this.trees.delete(repo);
    });
    return listing;
  }

  async text(repo: string, filePath: string): Promise<string> {
    const response = await this.raw(repo, filePath);
    return response.text();
  }

  async bytes(repo: string, filePath: string): Promise<Uint8Array> {
    const response = await this.raw(repo, filePath);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async raw(repo: string, filePath: string): Promise<Response> {
    const response = await this.deps.fetch(`${RAW}/${repo}/HEAD/${encodePath(filePath)}`, {
      headers: { 'User-Agent': 'overlord' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`GitHub answered ${String(response.status)} for ${filePath} in ${repo}.`);
    }
    return response;
  }

  private async list(repo: string): Promise<readonly RepoFile[]> {
    if (!isRepo(repo)) {
      throw new Error(`${repo} is not a GitHub repository name.`);
    }
    const token = await this.deps.token();
    const response = await this.deps.fetch(`${API}/repos/${repo}/git/trees/HEAD?recursive=1`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'overlord',
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 403 || response.status === 429) {
      throw new Error(
        token === null
          ? 'GitHub ran out of anonymous requests for this hour. Sign in to GitHub from the Accounts menu and try again.'
          : 'GitHub is rate limiting this account. Try again in a few minutes.',
      );
    }
    if (response.status === 404) {
      throw new Error(`GitHub has no public repository ${repo}.`);
    }
    if (!response.ok) {
      throw new Error(`GitHub answered ${String(response.status)} listing ${repo}.`);
    }
    const parsed = treeSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`GitHub sent a file list for ${repo} that Overlord cannot read.`);
    }
    if (parsed.data.truncated === true) {
      throw new Error(`${repo} is too large for GitHub to list in one go.`);
    }
    return parsed.data.tree
      .filter((entry) => entry.type === 'blob')
      .map((entry) => ({ path: entry.path, size: entry.size ?? 0 }));
  }
}
