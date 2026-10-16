// How hard each running session works this machine, like Activity Monitor
// or Task Manager: CPU, memory, disk and network for each session's whole
// process tree, the machine as a whole, and anything hogging, starved or stuck.

import type { ReactElement } from 'react';

import type {
  ActivityAlert,
  ActivityState,
  MachineActivity,
  VolumeActivity,
} from '../../../src/shared/activity.js';
import { Badge } from '../components/badge.js';
import { Meter } from '../components/meter.js';
import { formatBytes, formatClock, formatDuration } from '../format.js';
import { usePostAction } from '../vscode-context.js';

import { ActivityTable } from './activity-table.js';

function Stat(props: {
  readonly label: string;
  readonly children: ReactElement | string;
}): ReactElement {
  return (
    <div className="stat">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

function ratio(part: number | null, whole: number | null): number | null {
  return part === null || whole === null || whole <= 0 ? null : part / whole;
}

export function loadText(machine: MachineActivity): string {
  return `${machine.loadAverage[0].toFixed(1)} on ${String(machine.cores)} cores`;
}

function MachineStats(props: { readonly machine: MachineActivity }): ReactElement {
  const { machine } = props;
  return (
    <dl className="stats">
      <Stat label="CPU">
        <Meter label="CPU in use" ratio={ratio(machine.cpuPct, 100)} />
      </Stat>
      <Stat label="Load">{loadText(machine)}</Stat>
      <Stat label="Memory">
        <Meter
          label="Memory in use"
          ratio={ratio(machine.memoryUsedBytes, machine.memoryTotalBytes)}
        />
      </Stat>
      <Stat label="Swap">
        {machine.swapTotalBytes === null || machine.swapTotalBytes === 0
          ? 'none'
          : `${formatBytes(machine.swapUsedBytes)} of ${formatBytes(machine.swapTotalBytes)}`}
      </Stat>
    </dl>
  );
}

function AlertItem(props: { readonly alert: ActivityAlert }): ReactElement {
  const post = usePostAction();
  const { alert } = props;
  const { sessionId } = alert;
  return (
    <li>
      <Badge label={alert.level === 'critical' ? 'Critical' : 'Warning'} tone={alert.level} />{' '}
      {sessionId === null ? (
        <strong>{alert.subject}</strong>
      ) : (
        <button
          type="button"
          className="link-button"
          data-tip="Open the agent view for this session"
          onClick={() => {
            post({ type: 'openAgent', sessionId, agentId: sessionId });
          }}
        >
          {alert.subject}
        </button>
      )}
      : {alert.message}
    </li>
  );
}

function Alerts(props: { readonly alerts: readonly ActivityAlert[] }): ReactElement {
  return (
    <section className="section" aria-labelledby="activity-alerts">
      <h2 id="activity-alerts">Problems</h2>
      {props.alerts.length === 0 ? (
        <p className="muted">Nothing is hogging, starved or stuck.</p>
      ) : (
        <ul className="plain-list activity-alerts">
          {props.alerts.map((alert, index) => (
            <AlertItem key={`${alert.subject}:${String(index)}`} alert={alert} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function usedShare(volume: VolumeActivity): number | null {
  const free = ratio(volume.freeBytes, volume.totalBytes);
  return free === null ? null : 1 - free;
}

function VolumeRow(props: { readonly volume: VolumeActivity }): ReactElement {
  const { volume } = props;
  return (
    <tr>
      <td className="title-cell mono" data-tip={volume.path}>
        {volume.path}
      </td>
      <td className="num">{formatBytes(volume.freeBytes)}</td>
      <td className="num">{formatBytes(volume.totalBytes)}</td>
      <td>
        {volume.responding ? (
          <Meter label="Disk used" ratio={usedShare(volume)} />
        ) : (
          <Badge label="Not responding" tone="critical" />
        )}
      </td>
    </tr>
  );
}

function stallText(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`;
}

function MachineDetails(props: { readonly machine: MachineActivity }): ReactElement {
  const { machine } = props;
  return (
    <section className="section" aria-labelledby="activity-machine">
      <h2 id="activity-machine">Machine</h2>
      <dl className="props">
        <div className="prop">
          <dt>Memory</dt>
          <dd>
            {formatBytes(machine.memoryUsedBytes)} of {formatBytes(machine.memoryTotalBytes)} in use
          </dd>
        </div>
        {machine.memoryPressure === null ? null : (
          <div className="prop">
            <dt>Memory pressure</dt>
            <dd>{machine.memoryPressure}</dd>
          </div>
        )}
        {machine.stall === null ? null : (
          <div className="prop">
            <dt>Time spent waiting (last 10s)</dt>
            <dd>
              CPU {stallText(machine.stall.cpu)}, memory {stallText(machine.stall.memory)}, disk{' '}
              {stallText(machine.stall.io)}
            </dd>
          </div>
        )}
        {machine.cpuSpeedLimitPct === null ? null : (
          <div className="prop">
            <dt>CPU speed limit</dt>
            <dd>
              {machine.cpuSpeedLimitPct === 100
                ? 'Full speed'
                : `${String(machine.cpuSpeedLimitPct)}% (slowed for heat or power)`}
            </dd>
          </div>
        )}
        <div className="prop">
          <dt>Load average (1, 5, 15 minutes)</dt>
          <dd>{machine.loadAverage.map((value) => value.toFixed(2)).join(', ')}</dd>
        </div>
      </dl>
      <table className="grid">
        <caption className="visually-hidden">Disks holding session folders</caption>
        <thead>
          <tr>
            <th scope="col">Disk holding</th>
            <th scope="col" className="num">
              Free
            </th>
            <th scope="col" className="num">
              Size
            </th>
            <th scope="col">Used</th>
          </tr>
        </thead>
        <tbody>
          {machine.volumes.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                No session folders to check.
              </td>
            </tr>
          ) : (
            machine.volumes.map((volume) => <VolumeRow key={volume.path} volume={volume} />)
          )}
        </tbody>
      </table>
    </section>
  );
}

export function ActivityView(props: { readonly state: ActivityState }): ReactElement {
  const { state } = props;
  return (
    <section aria-labelledby="activity-title">
      <header className="view-header">
        <h1 id="activity-title">Activity</h1>
        <MachineStats machine={state.machine} />
      </header>
      <p className="muted">
        What each running session costs this machine, counting every process it started. CPU is a
        percent of one core, so a session using two cores shows 200%. Sampled every{' '}
        {formatDuration(state.intervalMs)} while this view is open
        {state.sampledAt === null ? '.' : `, last at ${formatClock(state.sampledAt)}.`}
      </p>
      {state.notes.length === 0 ? null : (
        <ul className="plain-list muted">
          {state.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <Alerts alerts={state.alerts} />
      <section className="section" aria-labelledby="activity-sessions">
        <h2 id="activity-sessions">Sessions</h2>
        <ActivityTable sessions={state.sessions} />
      </section>
      <MachineDetails machine={state.machine} />
    </section>
  );
}
