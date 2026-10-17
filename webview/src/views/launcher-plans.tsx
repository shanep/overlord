// Plans in the Launcher: describe a goal, read the tasks Claude splits it
// into, approve, and watch each task's session start once the tasks it
// depends on have landed.

import type { ReactElement } from 'react';
import { useState } from 'react';

import type { Plan, PlanState, PlanTask, PlanTaskState } from '../../../src/shared/plans.js';
import type { LauncherState } from '../../../src/shared/protocol.js';
import { Badge } from '../components/badge.js';
import { cardClassName, StatusDot } from '../components/card.js';
import type { Tone } from '../labels.js';
import { usePostAction } from '../vscode-context.js';

const PLAN_INFO: Readonly<Record<PlanState, { label: string; tone: Tone }>> = {
  drafting: { label: 'Drafting', tone: 'info' },
  draft: { label: 'Waiting for approval', tone: 'warning' },
  running: { label: 'Running', tone: 'info' },
  done: { label: 'Done', tone: 'good' },
  stopped: { label: 'Stopped', tone: 'warning' },
  failed: { label: 'Failed', tone: 'critical' },
};

const TASK_INFO: Readonly<Record<PlanTaskState, { label: string; tone: Tone }>> = {
  waiting: { label: 'Waiting', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  landed: { label: 'Landed', tone: 'good' },
  failed: { label: 'Failed', tone: 'critical' },
  stopped: { label: 'Stopped', tone: 'warning' },
};

function TaskRow(props: { readonly plan: Plan; readonly task: PlanTask }): ReactElement {
  const { plan, task } = props;
  const post = usePostAction();
  const info = TASK_INFO[task.state];
  const after = task.dependsOn
    .map((id) => plan.tasks.find((candidate) => candidate.id === id)?.title ?? id)
    .join(', ');
  const retry =
    (task.state === 'failed' || task.state === 'stopped') &&
    (plan.state === 'running' || plan.state === 'stopped');
  return (
    <li className="plan-task">
      <div className="plan-task-head">
        <Badge label={info.label} tone={info.tone} />
        <span className="card-title">{task.title}</span>
        <span className="spacer" />
        {task.sessionId === null ? null : (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              post({
                type: 'openAgent',
                sessionId: task.sessionId ?? '',
                agentId: task.sessionId ?? '',
              });
            }}
          >
            Open
          </button>
        )}
        {retry ? (
          <button
            type="button"
            aria-label={`Retry ${task.title}`}
            onClick={() => {
              post({ type: 'retryPlanTask', planId: plan.id, taskId: task.id });
            }}
          >
            Retry
          </button>
        ) : null}
      </div>
      {after === '' ? null : <p className="card-text">{`After ${after}.`}</p>}
      {task.note === null ? null : <p className="card-text">{task.note}</p>}
      {task.landedSha === null ? null : (
        <p className="card-text mono">{`Landed ${task.landedSha}`}</p>
      )}
      <details>
        <summary>Prompt</summary>
        <p className="plan-prompt">{task.prompt}</p>
        {task.files.length === 0 ? null : (
          <ul className="chip-list" aria-label={`Files ${task.title} changes`}>
            {task.files.map((file) => (
              <li key={file} className="chip mono">
                {file}
              </li>
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}

function PlanActions(props: { readonly plan: Plan }): ReactElement | null {
  const { plan } = props;
  const post = usePostAction();
  const discard = (
    <button
      type="button"
      onClick={() => {
        post({ type: 'discardPlan', planId: plan.id });
      }}
    >
      Discard
    </button>
  );
  if (plan.state === 'drafting') {
    return null;
  }
  if (plan.state === 'running') {
    return (
      <div className="card-foot">
        <span className="spacer" />
        <button
          type="button"
          className="danger"
          onClick={() => {
            post({ type: 'stopPlan', planId: plan.id });
          }}
        >
          Stop
        </button>
      </div>
    );
  }
  return (
    <div className="card-foot">
      <span className="spacer" />
      {discard}
      {plan.state === 'draft' ? (
        <button
          type="button"
          className="primary"
          onClick={() => {
            post({ type: 'approvePlan', planId: plan.id });
          }}
        >
          Approve and run
        </button>
      ) : null}
    </div>
  );
}

function PlanCard(props: { readonly plan: Plan }): ReactElement {
  const { plan } = props;
  const info = PLAN_INFO[plan.state];
  const headingId = `plan-${plan.id}`;
  const landed = plan.tasks.filter((task) => task.state === 'landed').length;
  return (
    <article
      className={cardClassName({ tone: info.tone, extra: 'plan' })}
      aria-labelledby={headingId}
    >
      <header className="tip-header">
        <StatusDot tone={info.tone} />
        <h3 id={headingId}>{plan.goal}</h3>
        <Badge label={info.label} tone={info.tone} />
      </header>
      <p className="card-sub mono" title={plan.cwd}>
        {plan.tasks.length === 0
          ? plan.cwd
          : `${plan.cwd}, ${String(landed)} of ${String(plan.tasks.length)} tasks landed`}
      </p>
      {plan.state === 'drafting' ? (
        <p className="card-text">
          Claude is reading the repository and splitting the goal into tasks…
        </p>
      ) : null}
      {plan.error === null ? null : <p className="card-text">{plan.error}</p>}
      {plan.summary === '' ? null : <p>{plan.summary}</p>}
      {plan.tasks.length === 0 ? null : (
        <ol className="plan-tasks" aria-label={`Tasks for ${plan.goal}`}>
          {plan.tasks.map((task) => (
            <TaskRow key={task.id} plan={plan} task={task} />
          ))}
        </ol>
      )}
      <PlanActions plan={plan} />
    </article>
  );
}

function PlanForm(props: {
  readonly folders: LauncherState['folders'];
  readonly defaultFolder: string;
}): ReactElement {
  const post = usePostAction();
  const [goal, setGoal] = useState('');
  // The default folder when the list has it, else the first one the picker shows.
  const start = props.folders.some((item) => item.folder === props.defaultFolder)
    ? props.defaultFolder
    : (props.folders[0]?.folder ?? '');
  const [folder, setFolder] = useState(start);
  const ready = goal.trim() !== '' && folder !== '';
  return (
    <form
      className="card-form plan-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) {
          post({ type: 'draftPlan', goal: goal.trim(), cwd: folder });
          setGoal('');
        }
      }}
    >
      <label className="field">
        <span>Goal</span>
        <textarea
          rows={3}
          value={goal}
          placeholder="What should be built or fixed, in a sentence or two"
          onChange={(event) => {
            setGoal(event.target.value);
          }}
        />
      </label>
      <label className="field">
        <span>Repository</span>
        <select
          value={folder}
          onChange={(event) => {
            setFolder(event.target.value);
          }}
        >
          {props.folders.map((item) => (
            <option key={item.folder} value={item.folder} title={item.folder}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!ready}>
          Draft plan
        </button>
      </div>
    </form>
  );
}

export function PlansSection(props: {
  readonly plans: LauncherState['plans'];
  readonly folders: LauncherState['folders'];
  readonly defaultFolder: string;
}): ReactElement {
  return (
    <section className="section" aria-labelledby="plans-heading">
      <div className="list-bar">
        <h2 id="plans-heading">Plans</h2>
      </div>
      <p className="hint">
        Describe a goal and Claude splits it into tasks for separate sessions, each in its own
        worktree. Approve the plan and each task starts once the tasks it depends on have landed.
      </p>
      <PlanForm folders={props.folders} defaultFolder={props.defaultFolder} />
      {props.plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} />
      ))}
    </section>
  );
}
