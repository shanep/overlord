// "New agent" and "New skill": start from a template or describe it and let
// Claude draft it, name it, pick where it goes, then write and open the file.
// User scope goes into the config repo when one is connected, linked back into
// ~/.claude, so the new file is versioned from the start.

import type { LaunchRun } from '../../shared/protocol.js';
import { buildDraftPrompt, extractDraftText } from '../authoring/draft-prompt.js';
import { renderAgent, renderSkill } from '../authoring/render.js';
import type { AuthoringKind } from '../authoring/schema.js';
import { nameProblems } from '../authoring/schema.js';
import type { AuthoringTemplate } from '../authoring/templates.js';
import { findTemplate, TEMPLATES } from '../authoring/templates.js';
import { parseAgentFile, parseSkillFile } from '../authoring/validate.js';
import type { Launcher } from '../harness/launcher.js';
import { isTerminal } from '../harness/launcher.js';

import type { PickItem } from './host-port.js';
import type { Runtime } from './runtime.js';

export const DESCRIBE_ID = 'describe';

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

/** Has Claude draft the file through the launcher, so the run shows up there too. */
export async function draftText(rt: Runtime, kind: AuthoringKind): Promise<string | null> {
  const entered = await rt.host.inputBox({ prompt: `Describe the ${kind} you want`, value: '' });
  const description = entered?.trim() ?? '';
  if (description === '') {
    return null;
  }
  const batchId = rt.launcher.launch(
    [
      {
        prompt: buildDraftPrompt(kind, description),
        cwd: rt.host.workspaceFolder() ?? rt.paths.home,
        profileId: null,
        worktree: false,
        maxBudgetUsd: null,
        label: `Draft a new ${kind}`,
      },
    ],
    [],
  );
  rt.host.showInfo(`Claude is drafting the ${kind}. It shows in the launcher.`);
  const run = await waitForBatch(rt.launcher, batchId);
  if (run.state !== 'done' || run.result === null) {
    rt.host.showError(`Claude could not draft the ${kind}.`);
    return null;
  }
  return extractDraftText(run.result);
}

/** The new file's text, from a template or a draft. Null when the user backed out. */
export async function authoredText(
  rt: Runtime,
  kind: AuthoringKind,
): Promise<{ readonly name: string; readonly text: string } | null> {
  const source = await rt.host.quickPick(sourceItems(kind), `Start the new ${kind} from`);
  const template = source === null ? null : findTemplate(source);
  if (source === null || (template === null && source !== DESCRIBE_ID)) {
    return null;
  }
  const name = await askName(rt, kind);
  if (name === null) {
    return null;
  }
  if (template !== null) {
    return { name, text: renderNamed(template, name) };
  }
  const drafted = await draftText(rt, kind);
  return drafted === null ? null : { name, text: withName(kind, drafted, name) };
}
