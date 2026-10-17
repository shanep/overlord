// Where things live inside the config repo (shanep/overlord-config by default).

import path from 'node:path';

import { CLAUDE_CODE, CODEX, COPILOT } from '../../shared/agents.js';

export interface ConfigRepoLayout {
  readonly manifest: string;
  readonly globalClaudeMd: string;
  readonly globalSettings: string;
  readonly globalRules: string;
  readonly skills: string;
  readonly agents: string;
  readonly commands: string;
  readonly outputStyles: string;
  readonly hooks: string;
  readonly mcp: string;
  readonly plugins: string;
  readonly external: string;
  readonly machines: string;
  readonly memory: string;
}

/** Paths relative to the repo root, always with forward slashes. */
export const LAYOUT: ConfigRepoLayout = {
  manifest: 'overlord.json',
  globalClaudeMd: 'global/CLAUDE.md',
  globalSettings: 'global/settings.json',
  globalRules: 'global/rules',
  skills: 'skills',
  agents: 'agents',
  commands: 'commands',
  outputStyles: 'output-styles',
  hooks: 'hooks',
  mcp: 'mcp.json',
  plugins: 'plugins.json',
  external: 'external.json',
  machines: 'machines',
  memory: 'memory',
};

/** A host name safe to use as a file name: lower case, no ".local", only [a-z0-9.-]. */
export function sanitizeHost(host: string): string {
  const lower = host
    .trim()
    .toLowerCase()
    .replace(/\.local$/u, '');
  const cleaned = lower.replaceAll(/[^a-z0-9.-]/gu, '-').replaceAll(/^\.+/gu, '');
  return cleaned === '' ? 'unknown-host' : cleaned;
}

/**
 * Each agent past Claude Code keeps its config under agents/<id>/, with its
 * own overlord.json there. Claude Code keeps global/ and the folders at the
 * top, so a repo made before other agents synced applies as it always has.
 * agents/ also holds Claude Code's own agent files, which is why Claude agent
 * folders named after an agent are never adopted.
 */
export function agentRepoDir(agent: string): string {
  return `${LAYOUT.agents}/${agent}`;
}

const AGENT_FOLDERS: ReadonlySet<string> = new Set([CLAUDE_CODE, CODEX, COPILOT]);

/** True for a folder name under agents/ that belongs to an agent, not to Claude Code's agent files. */
export function isAgentFolder(name: string): boolean {
  return AGENT_FOLDERS.has(name);
}

export function agentManifestPath(agent: string): string {
  return `${agentRepoDir(agent)}/${LAYOUT.manifest}`;
}

export function agentMachineSettingsPath(agent: string, host: string): string {
  return `${agentRepoDir(agent)}/${LAYOUT.machines}/${sanitizeHost(host)}.json`;
}

export function machineSettingsPath(host: string): string {
  return `${LAYOUT.machines}/${sanitizeHost(host)}.json`;
}

export function memoryPath(slug: string): string {
  return `${LAYOUT.memory}/${slug}`;
}

/** Absolute path of a repo relative path. */
export function repoFile(repoRoot: string, relative: string): string {
  return path.join(repoRoot, ...relative.split('/'));
}

/** Turn "~" and "~/x" into absolute paths under `home`. */
export function expandHome(target: string, home: string): string {
  if (target === '~') {
    return home;
  }
  if (target.startsWith('~/')) {
    return path.join(home, ...target.slice(2).split('/'));
  }
  return target;
}

/** The inverse of expandHome, with forward slashes, for manifests and summaries. */
export function collapseHome(target: string, home: string): string {
  const relative = path.relative(home, target);
  if (relative === '') {
    return '~';
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return target;
  }
  return `~/${relative.split(path.sep).join('/')}`;
}

const SEGMENT = /^[\w.-]+$/u;

function hostOf(authority: string): string {
  const withoutUser = authority.slice(authority.lastIndexOf('@') + 1);
  const colon = withoutUser.indexOf(':');
  return colon === -1 ? withoutUser : withoutUser.slice(0, colon);
}

/** Split a remote URL into host and path, for scheme URLs and the scp form user@host:path. */
function splitRemote(url: string): readonly [string, string] | null {
  const trimmed = url.trim();
  const scheme = trimmed.indexOf('://');
  if (scheme > 0) {
    const rest = trimmed.slice(scheme + 3);
    const slash = rest.indexOf('/');
    return slash > 0 ? [hostOf(rest.slice(0, slash)), rest.slice(slash + 1)] : null;
  }
  const colon = trimmed.indexOf(':');
  const authority = trimmed.slice(0, colon);
  if (colon <= 0 || authority.includes('/')) {
    return null;
  }
  return [hostOf(authority), trimmed.slice(colon + 1)];
}

function trimEnd(text: string, suffix: string): string {
  let out = text;
  while (out.endsWith(suffix)) {
    out = out.slice(0, -suffix.length);
  }
  return out;
}

/**
 * A stable key for a git remote, the same for its ssh and https forms:
 * git@github.com:a/b.git and https://github.com/a/b both become github.com/a/b.
 * Lower case, since GitHub and most hosts ignore case. Null for local paths and
 * anything that would not be a safe directory name.
 */
export function remoteSlug(url: string): string | null {
  const parts = splitRemote(url);
  if (parts === null) {
    return null;
  }
  const [host, rest] = parts;
  const segments = trimEnd(trimEnd(rest, '/'), '.git')
    .split('/')
    .filter((segment) => segment !== '');
  const all = [host, ...segments];
  const safe = all.every((part) => SEGMENT.test(part) && part !== '.' && part !== '..');
  return safe && segments.length > 0 ? all.join('/').toLowerCase() : null;
}
