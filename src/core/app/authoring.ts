// "New agent" and "New skill": start from a template or describe it and let
// Claude draft it, name it, pick where it goes, then write and open the file.
// User scope goes into the config repo when one is connected, linked back into
// ~/.claude, so the new file is versioned from the start. With another agent
// in play, a new agent first asks which agent it is for and comes out in that
// agent's format, and a drafted skill is told who else reads it.

import { CLAUDE_CODE } from '../../shared/agents.js';
import type { LaunchRun } from '../../shared/protocol.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { DraftFor } from '../authoring/draft-prompt.js';
import { buildDraftPrompt, extractDraftText } from '../authoring/draft-prompt.js';
import type { LibraryReader } from '../authoring/library.js';
import { renderAgent, renderSkill } from '../authoring/render.js';
import type { AuthoringKind } from '../authoring/schema.js';
import { nameProblems } from '../authoring/schema.js';
import type { AuthoringTemplate } from '../authoring/templates.js';
import { findTemplate, TEMPLATES } from '../authoring/templates.js';
import { parseAgentFile, parseSkillFile } from '../authoring/validate.js';
import type { Launcher } from '../harness/launcher.js';
import { isTerminal } from '../harness/launcher.js';

import type { PickItem } from './host-port.js';
import { readersInPlay } from './library-scan.js';
import type { Runtime } from './runtime.js';

export const DESCRIBE_ID = 'describe';

/** Who a new file is for. */
export interface AuthoringTarget {
  /** The agent a new agent file is for. Claude Code for a skill, whose folder decides who reads it. */
  readonly reader: LibraryReader;
  /** Every agent in play. */
  readonly readers: readonly LibraryReader[];
}

/** The file text with its frontmatter name set, when the text parses. */
export function withName(kind: AuthoringKind, text: string, name: string): string {
  if (kind === 'agent') {
    const { spec } = parseAgentFile(text);
    return spec === null
      ? text
      : renderAgent({ ...spec, frontmatter: { ...spec.frontmatter, name } });
  }
  const { spec } = parseSkillFile(text);
  return spec === null
    ? text
    : renderSkill({ ...spec, frontmatter: { ...spec.frontmatter, name } });
}

export function renderNamed(template: AuthoringTemplate, name: string): string {
  if (template.kind === 'agent') {
    const { spec } = template;
    return renderAgent({ ...spec, frontmatter: { ...spec.frontmatter, name } });
  }
  const { spec } = template;
  return renderSkill({ ...spec, frontmatter: { ...spec.frontmatter, name } });
}

function isClaude(target: AuthoringTarget): boolean {
  return target.reader.id === CLAUDE_CODE;
}

/** A template for the target: Claude Code's own as before, or mapped onto another agent's format. */
function renderFor(template: AuthoringTemplate, name: string, target: AuthoringTarget): string {
  const agentFiles = target.reader.library.agents;
  if (template.kind === 'skill' || isClaude(target) || agentFiles === undefined) {
    return renderNamed(template, name);
  }
  const { spec } = template;
  return agentFiles.render({ ...spec, frontmatter: { ...spec.frontmatter, name } });
}

/** A draft for the target with its name set. */
function namedFor(
  kind: AuthoringKind,
  text: string,
  name: string,
  target: AuthoringTarget,
): string {
  const agentFiles = target.reader.library.agents;
  if (kind === 'skill' || isClaude(target) || agentFiles === undefined) {
    return withName(kind, text, name);
  }
  return agentFiles.withName(text, name);
}

/** What the drafting prompt says about who the file is for. Empty for Claude Code alone. */
function draftFor(kind: AuthoringKind, target: AuthoringTarget): DraftFor {
  if (kind === 'agent') {
    const guide = target.reader.library.agents?.guide;
    return isClaude(target) || guide === undefined ? {} : { guide };
  }
  const others = target.readers.filter(
    (reader) => reader.id !== CLAUDE_CODE && reader.library.skills !== undefined,
  );
  return others.length === 0 ? {} : { alsoReadBy: others.map((reader) => reader.name) };
}

/** The kind as the messages name it, like "agent" or "Copilot agent". */
function what(kind: AuthoringKind, target: AuthoringTarget): string {
  return kind === 'agent' && !isClaude(target) ? `${target.reader.short} ${kind}` : kind;
}

/**
 * Who a new file is for. A skill is Claude Code's, and its folder decides
 * who else reads it. A new agent asks which agent it is for once more than
 * one agent in play has agent files. Null when the user backed out.
 */
export async function pickAuthoringTarget(
  rt: Runtime,
  kind: AuthoringKind,
  registry?: AgentRegistry,
): Promise<AuthoringTarget | null> {
  const readers = await readersInPlay(rt, registry);
  const claude = readers.find((reader) => reader.id === CLAUDE_CODE);
  const writers =
    kind === 'agent' ? readers.filter((reader) => reader.library.agents !== undefined) : [];
  if (writers.length <= 1) {
    const reader = writers[0] ?? claude;
    return reader === undefined ? null : { reader, readers };
  }
  const items: PickItem[] = writers.map((reader) => ({
    id: reader.id,
    label: reader.name,
    description: `Saved as a ${reader.library.agents?.suffix ?? '.md'} file`,
  }));
  const picked = await rt.host.quickPick(items, 'Which agent is the new agent for?');
  const reader = writers.find((candidate) => candidate.id === picked);
  return reader === undefined ? null : { reader, readers };
}

function sourceItems(kind: AuthoringKind): PickItem[] {
  return [
    ...TEMPLATES.filter((template) => template.kind === kind).map((template) => ({
      id: template.id,
      label: template.label,
      description: template.summary,
    })),
    {
      id: DESCRIBE_ID,
      label: 'Describe it',
      description: 'Write what you want and Claude drafts it.',
    },
  ];
}

export async function askName(rt: Runtime, kind: AuthoringKind): Promise<string | null> {
  const entered = await rt.host.inputBox({
    prompt: `Name for the new ${kind}: lowercase letters, digits and hyphens`,
    value: '',
  });
  const name = entered?.trim() ?? '';
  if (name === '') {
    return null;
  }
  const [problem] = nameProblems(kind, name);
  if (problem !== undefined) {
    rt.host.showError(problem);
    return null;
  }
  return name;
}

/** Resolves once the run of this batch reaches a final state. */
async function waitForBatch(launcher: Launcher, batchId: string): Promise<LaunchRun> {
  return new Promise((resolve) => {
    const off = launcher.onChange((run) => {
      if (run.batchId === batchId && isTerminal(run.state)) {
        off();
        resolve(run);
      }
    });
  });
}

/**
 * Has Claude draft the file through the launcher, so the run shows up there
 * too. Claude drafts every agent's files, and the prompt says which agent
 * the file is for.
 */
export async function draftText(
  rt: Runtime,
  kind: AuthoringKind,
  target: AuthoringTarget | null = null,
): Promise<string | null> {
  const label = target === null ? kind : what(kind, target);
  const entered = await rt.host.inputBox({ prompt: `Describe the ${label} you want`, value: '' });
  const description = entered?.trim() ?? '';
  if (description === '') {
    return null;
  }
  const batchId = rt.launcher.launch(
    [
      {
        prompt: buildDraftPrompt(kind, description, target === null ? {} : draftFor(kind, target)),
        cwd: rt.host.workspaceFolder() ?? rt.paths.home,
        profileId: null,
        worktree: false,
        maxBudgetUsd: null,
        label: `Draft a new ${label}`,
      },
    ],
    [],
  );
  rt.host.showInfo(`Claude is drafting the ${label}. It shows in the launcher.`);
  const run = await waitForBatch(rt.launcher, batchId);
  if (run.state !== 'done' || run.result === null) {
    rt.host.showError(`Claude could not draft the ${label}.`);
    return null;
  }
  return extractDraftText(run.result);
}

/** The new file's text, from a template or a draft. Null when the user backed out. */
export async function authoredText(
  rt: Runtime,
  kind: AuthoringKind,
  target: AuthoringTarget,
): Promise<{ readonly name: string; readonly text: string } | null> {
  const source = await rt.host.quickPick(
    sourceItems(kind),
    `Start the new ${what(kind, target)} from`,
  );
  const template = source === null ? null : findTemplate(source);
  if (source === null || (template === null && source !== DESCRIBE_ID)) {
    return null;
  }
  const name = await askName(rt, kind);
  if (name === null) {
    return null;
  }
  if (template !== null) {
    return { name, text: renderFor(template, name, target) };
  }
  const drafted = await draftText(rt, kind, target);
  return drafted === null ? null : { name, text: namedFor(kind, drafted, name, target) };
}
