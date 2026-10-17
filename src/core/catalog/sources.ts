// The public collections the Skills and Agents views browse. Each GitHub
// collection names the files that are entries: a SKILL.md for a skill, whose
// whole folder installs, or one Markdown file per agent. The first capture
// group, when there is one, is the category or plugin the entry sits under.

import type { CatalogKind, CatalogSource } from '../../shared/catalog.js';

export const SKILLS_SH = 'skills.sh';

export interface RepoSource extends CatalogSource {
  readonly kind: CatalogKind;
  readonly match: RegExp;
}

const SKILL_SOURCES: readonly RepoSource[] = [
  {
    id: 'anthropics/skills',
    kind: 'skill',
    label: 'Anthropic',
    description:
      "Anthropic's own skills: documents (PDF, Word, Excel, PowerPoint), art and design, building MCP servers and more skills, and testing web apps.",
    url: 'https://github.com/anthropics/skills',
    search: false,
    match: /^skills\/[^/]+\/SKILL\.md$/u,
  },
  {
    id: 'obra/superpowers',
    kind: 'skill',
    label: 'Superpowers',
    description:
      'A working method for coding agents: brainstorm, write a plan, test first, debug systematically, review, and finish a branch.',
    url: 'https://github.com/obra/superpowers',
    search: false,
    match: /^skills\/[^/]+\/SKILL\.md$/u,
  },
  {
    id: 'wshobson/agents',
    kind: 'skill',
    label: 'wshobson/agents',
    description:
      'The skills from a large plugin collection, grouped by plugin: languages, frameworks, cloud, security, testing and more.',
    url: 'https://github.com/wshobson/agents',
    search: false,
    match: /^plugins\/([^/]+)\/skills\/[^/]+\/SKILL\.md$/u,
  },
];

const AGENT_SOURCES: readonly RepoSource[] = [
  {
    id: 'VoltAgent/awesome-claude-code-subagents',
    kind: 'agent',
    label: 'VoltAgent',
    description:
      'A curated catalog of subagents in categories: core development, languages, infrastructure, quality and security, data and AI, and more.',
    url: 'https://github.com/VoltAgent/awesome-claude-code-subagents',
    search: false,
    match: /^categories\/\d+-([^/]+)\/(?!README\.md$)[^/]+\.md$/u,
  },
  {
    id: 'wshobson/agents',
    kind: 'agent',
    label: 'wshobson/agents',
    description:
      'The agents from a large plugin collection, grouped by plugin, from architects and reviewers to language and cloud specialists.',
    url: 'https://github.com/wshobson/agents',
    search: false,
    match: /^plugins\/([^/]+)\/agents\/[^/]+\.md$/u,
  },
];

/** skills.sh indexes skills from every public repository and ranks them by installs. */
export const SKILLS_SH_SOURCE: CatalogSource = {
  id: SKILLS_SH,
  label: 'Search skills.sh',
  description:
    'The open skills directory: every public skill it has seen, ranked by how often people install it. Search by name.',
  url: 'https://skills.sh',
  search: true,
};

export function repoSources(kind: CatalogKind): readonly RepoSource[] {
  return kind === 'skill' ? SKILL_SOURCES : AGENT_SOURCES;
}

/** Every source the view offers, the first one being where it opens. */
export function catalogSources(kind: CatalogKind): readonly CatalogSource[] {
  const sources = repoSources(kind).map(
    ({ id, label, description, url, search }): CatalogSource => ({
      id,
      label,
      description,
      url,
      search,
    }),
  );
  return kind === 'skill' ? [...sources, SKILLS_SH_SOURCE] : sources;
}

/** The group a path belongs to when it is an entry of the source, else null. */
export function entryGroup(source: RepoSource, filePath: string): string | null {
  const match = source.match.exec(filePath);
  return match === null ? null : (match[1] ?? '');
}
