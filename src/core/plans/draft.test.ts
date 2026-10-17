import { describe, expect, it } from 'vitest';

import type { Exec } from '../sync/exec.js';

import { draftPlan, draftPrompt, parseDraft, tidy } from './draft.js';

const TASK = { title: 'T', prompt: 'Do it.', files: [] };

const notLoggedIn: Exec = async () => {
  await Promise.resolve();
  return { code: 1, stdout: '', stderr: 'not logged in\n' };
};

describe('parseDraft', () => {
  it('reads structured output, or the JSON in the text of the answer', () => {
    const plan = { summary: 'Two steps.', tasks: [{ id: 'a', ...TASK, dependsOn: [] }] };
    expect(parseDraft(JSON.stringify({ structured_output: plan }))).toStrictEqual(plan);
    expect(
      parseDraft(JSON.stringify({ result: `Here:\n${JSON.stringify(plan)}\nDone.` })),
    ).toStrictEqual(plan);
    expect(() => parseDraft(JSON.stringify({ result: 'no plan' }))).toThrow(
      'did not answer with a plan',
    );
    expect(() =>
      parseDraft(JSON.stringify({ structured_output: { summary: '', tasks: [] } })),
    ).toThrow();
  });
});

describe('tidy', () => {
  it('orders tasks after their dependencies and drops unknown, self and duplicate ones', () => {
    const tidied = tidy({
      summary: '',
      tasks: [
        { id: 'ui', ...TASK, dependsOn: ['store', 'ghost', 'ui', 'store'] },
        { id: 'store', ...TASK, dependsOn: [] },
        { id: 'store', ...TASK, dependsOn: ['ui'] },
      ],
    });
    expect(tidied.tasks.map((task) => [task.id, task.dependsOn])).toStrictEqual([
      ['store', []],
      ['ui', ['store']],
    ]);
  });

  it('breaks a loop by dropping the dependency that closes it', () => {
    const tidied = tidy({
      summary: '',
      tasks: [
        { id: 'a', ...TASK, dependsOn: ['b'] },
        { id: 'b', ...TASK, dependsOn: ['c'] },
        { id: 'c', ...TASK, dependsOn: ['a'] },
      ],
    });
    expect(tidied.tasks.map((task) => [task.id, task.dependsOn])).toStrictEqual([
      ['c', []],
      ['b', ['c']],
      ['a', ['b']],
    ]);
  });
});

describe('draftPlan', () => {
  it('asks the planner read only, in the repository, and reads its answer', async () => {
    const calls: { command: string; args: readonly string[]; cwd: string | undefined }[] = [];
    const exec: Exec = async (command, args, options) => {
      await Promise.resolve();
      calls.push({ command, args, cwd: options.cwd });
      return {
        code: 0,
        stdout: JSON.stringify({
          structured_output: { summary: 'S', tasks: [{ id: 'a', ...TASK, dependsOn: [] }] },
        }),
        stderr: '',
      };
    };
    const draft = await draftPlan({
      exec,
      claude: '/bin/claude',
      cwd: '/repo',
      goal: 'Add dark mode',
    });
    expect(draft.tasks.map((task) => task.id)).toStrictEqual(['a']);
    expect(calls[0]?.command).toBe('/bin/claude');
    expect(calls[0]?.cwd).toBe('/repo');
    expect(calls[0]?.args).toContain(draftPrompt('Add dark mode'));
    expect(calls[0]?.args.slice(calls[0].args.indexOf('--disallowedTools'))).toContain('Edit');
  });

  it('says why the planner failed', async () => {
    const exec = notLoggedIn;
    await expect(draftPlan({ exec, claude: 'claude', cwd: '/r', goal: 'g' })).rejects.toThrow(
      'The planner stopped with exit code 1: not logged in',
    );
  });
});
