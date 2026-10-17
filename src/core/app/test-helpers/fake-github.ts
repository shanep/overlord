// A fetch that answers like GitHub and skills.sh for the Skills and Agents
// views: a file list per repository, raw files, and a skills.sh search.

import type { FetchFunction } from '../../sync/github.js';

export type RepoFiles = Readonly<Record<string, string>>;

const TREE = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees\/HEAD\?recursive=1$/u;
const RAW = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/HEAD\/(.+)$/u;
const SEARCH = 'https://skills.sh/api/search?';

export interface SearchHit {
  readonly id: string;
  readonly source: string;
  readonly skillId: string;
  readonly name: string;
  readonly installs?: number;
}

export class FakeGitHub {
  readonly urls: string[] = [];
  /** The Authorization header each file list call sent, or null. */
  readonly auth: (string | null)[] = [];
  /** Answers every file list call with this status instead, when set. */
  treeStatus: number | null = null;
  /** Answers every raw file with this status instead, when set. */
  rawStatus: number | null = null;
  truncated = false;
  hits: readonly SearchHit[] = [];
  searchStatus: number | null = null;
  private readonly repos: Readonly<Record<string, RepoFiles>>;

  constructor(repos: Readonly<Record<string, RepoFiles>>) {
    this.repos = repos;
  }

  readonly fetch: FetchFunction = async (url, init) => {
    await Promise.resolve();
    this.urls.push(url);
    const tree = TREE.exec(url);
    if (tree !== null) {
      const headers = new Headers(init.headers);
      this.auth.push(headers.get('Authorization'));
      return this.tree(tree[1] ?? '');
    }
    const raw = RAW.exec(url);
    if (raw !== null) {
      return this.raw(raw[1] ?? '', decodeURIComponent(raw[2] ?? ''));
    }
    if (url.startsWith(SEARCH)) {
      return this.searchStatus === null
        ? Response.json({ query: '', skills: this.hits })
        : new Response('', { status: this.searchStatus });
    }
    return new Response('', { status: 404 });
  };

  /** How many file list calls went to the REST API. */
  treeCalls(): number {
    return this.urls.filter((url) => TREE.test(url)).length;
  }

  private tree(repo: string): Response {
    if (this.treeStatus !== null) {
      return new Response('', { status: this.treeStatus });
    }
    const files = this.repos[repo];
    if (files === undefined) {
      return new Response('', { status: 404 });
    }
    const blobs = Object.entries(files).map(([path, text]) => ({
      path,
      type: 'blob',
      size: new TextEncoder().encode(text).length,
    }));
    return Response.json({
      truncated: this.truncated,
      tree: [{ path: 'docs', type: 'tree' }, ...blobs],
    });
  }

  private raw(repo: string, path: string): Response {
    const text = this.repos[repo]?.[path];
    if (this.rawStatus !== null || text === undefined) {
      return new Response('', { status: this.rawStatus ?? 404 });
    }
    return new Response(text);
  }
}

export function skillFile(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

export function agentFile(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ntools: Read, Grep\n---\n\nYou are ${name}.\n`;
}
