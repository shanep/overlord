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
import { Card, CardGrid, Notice, StatTile, StatTiles, StatusDot } from '../components/card.js';
import { Meter, meterTone } from '../components/meter.js';
import { formatBytes, formatClock, formatDuration } from '../format.js';
import type { Tone } from '../labels.js';
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

function AlertCard(props: { readonly alert: ActivityAlert }): ReactElement {
  const post = usePostAction();
  const { alert } = props;
  const { sessionId } = alert;
  return (
    <Card tone={alert.level}>
      <div className="card-head">
        <StatusDot tone={alert.level} />
        {sessionId === null ? (
          <strong className="card-title">{alert.subject}</strong>
        ) : (
          <button
            type="button"
            className="link-button card-title"
            data-tip="Open the agent view for this session"
            onClick={() => {
              post({ type: 'openAgent', sessionId, agentId: sessionId });
            }}
          >
            {alert.subject}
          </button>
        )}
        <Badge label={alert.level === 'critical' ? 'Critical' : 'Warning'} tone={alert.level} />
      </div>
      <p className="card-text activity-indent-card">{alert.message}</p>
    </Card>
  );
}

function Alerts(props: { readonly alerts: readonly ActivityAlert[] }): ReactElement {
  const { alerts } = props;
  return (
    <section className="card-group" aria-labelledby="activity-alerts">
      <h2 id="activity-alerts">
        Problems{' '}
        {alerts.length === 0 ? null : <span className="count">{String(alerts.length)}</span>}
      </h2>
      {alerts.length === 0 ? (
        <Notice ok>Nothing is hogging, starved or stuck.</Notice>
      ) : (
        <CardGrid labelledBy="activity-alerts" wide>
          {alerts.map((alert, index) => (
            <AlertCard key={`${alert.subject}:${String(index)}`} alert={alert} />
          ))}
        </CardGrid>
      )}
    </section>
  );
}

export function usedShare(volume: VolumeActivity): number | null {
  const free = ratio(volume.freeBytes, volume.totalBytes);
  return free === null ? null : 1 - free;
}

function VolumeCard(props: { readonly volume: VolumeActivity }): ReactElement {
  const { volume } = props;
  const used = usedShare(volume);
  let tone: Tone | undefined;
  if (!volume.responding) {
    tone = 'critical';
  } else if (used !== null && meterTone(used) !== 'info') {
    tone = meterTone(used);
  }
  return (
    <Card {...(tone === undefined ? {} : { tone })}>
      <div className="card-head">
        <span className="card-title mono" data-tip={volume.path}>
          {volume.path}
        </span>
        {volume.responding ? null : <Badge label="Not responding" tone="critical" />}
      </div>
      {volume.responding ? <Meter label="Disk used" ratio={used} /> : null}
      <span className="card-sub">
        {volume.responding
          ? `${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.totalBytes)}`
          : 'The disk did not answer in time, as a hung network mount does.'}
      </span>
    </Card>
  );
}

function stallText(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`;
}

function pressureTone(pressure: MachineActivity['memoryPressure']): Tone | undefined {
  return pressure === 'warning' || pressure === 'critical' ? pressure : undefined;
}

function MachineDetails(props: { readonly machine: MachineActivity }): ReactElement {
  const { machine } = props;
  return (
    <section className="section" aria-labelledby="activity-machine">
      <h2 id="activity-machine" className="section-title">
        Machine
      </h2>
      <StatTiles label="Machine">
        <StatTile
          label="Memory"
          value={formatBytes(machine.memoryUsedBytes)}
          detail={`of ${formatBytes(machine.memoryTotalBytes)} in use`}
        />
        {machine.memoryPressure === null ? null : (
          <StatTile
            label="Memory pressure"
            value={machine.memoryPressure}
            tone={pressureTone(machine.memoryPressure)}
          />
        )}
        <StatTile
          label="Load average"
          value={machine.loadAverage[0].toFixed(2)}
          detail={`1, 5, 15 minutes: ${machine.loadAverage.map((value) => value.toFixed(2)).join(', ')}`}
        />
        {machine.cpuSpeedLimitPct === null ? null : (
          <StatTile
            label="CPU speed limit"
            value={
              machine.cpuSpeedLimitPct === 100
                ? 'Full speed'
                : `${String(machine.cpuSpeedLimitPct)}%`
            }
            detail={machine.cpuSpeedLimitPct === 100 ? undefined : 'Slowed for heat or power'}
            tone={machine.cpuSpeedLimitPct === 100 ? undefined : 'warning'}
          />
        )}
        {machine.stall === null ? null : (
          <StatTile
            label="Time spent waiting (last 10s)"
            value={stallText(machine.stall.cpu)}
            detail={`CPU ${stallText(machine.stall.cpu)}, memory ${stallText(machine.stall.memory)}, disk ${stallText(machine.stall.io)}`}
          />
        )}
      </StatTiles>
      <h3 id="activity-disks">Disks holding session folders</h3>
      {machine.volumes.length === 0 ? (
        <p className="empty-line muted">No session folders to check.</p>
      ) : (
        <CardGrid labelledBy="activity-disks">
          {machine.volumes.map((volume) => (
            <VolumeCard key={volume.path} volume={volume} />
          ))}
        </CardGrid>
      )}
    </section>
  );
}

export function ActivityView(props: { readonly state: ActivityState }): ReactElement {
  const { state } = props;
  return (
    <section className="activity" aria-labelledby="activity-title">
      <header className="view-header">
        <h1 id="activity-title">Activity</h1>
        <MachineStats machine={state.machine} />
      </header>
      <details className="about">
        <summary>How this works</summary>
        <p>
          What each running session costs this machine, counting every process it started. CPU is a
          percent of one core, so a session using two cores shows 200%. Sampled every{' '}
          {formatDuration(state.intervalMs)} while this view is open
          {state.sampledAt === null ? '.' : `, last at ${formatClock(state.sampledAt)}.`}
        </p>
        {state.notes.length === 0 ? null : (
          <ul>
            {state.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </details>
      <Alerts alerts={state.alerts} />
      <section className="section" aria-labelledby="activity-sessions">
        <h2 id="activity-sessions" className="section-title">
          Sessions
        </h2>
        <ActivityTable sessions={state.sessions} />
      </section>
      <MachineDetails machine={state.machine} />
    </section>
  );
}
