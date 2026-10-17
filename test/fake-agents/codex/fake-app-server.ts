// An in-process stand-in for `codex app-server` that replays an exchange in
// the format of test/fixtures/codex/0.163.0/app-server/session.jsonl. Each
// thing the client sends starts the server lines recorded after it, matched
// by method (or by the server request a reply answers), so the client may
// send in its own order. Reply ids are rewritten to the client's own. Tests
// use it through the runtime's spawn port and never start a real codex.

import { readFileSync } from 'node:fs';

import type {
  AppServerExit,
  AppServerLaunch,
  AppServerProcess,
  AppServerSpawn,
} from '../../../src/core/agents/codex/rpc.js';
import { AsyncQueue } from '../../../src/core/harness/input-queue.js';

export type Message = Readonly<Record<string, unknown>>;

/** One line of a recording, plus an exit line for a server that dies. */
export type Recorded =
  | { readonly dir: 'send' | 'recv'; readonly msg: Message }
  | { readonly dir: 'exit'; readonly code: number; readonly stderr: string };

const RECORDED_SESSION = new URL(
  '../../fixtures/codex/0.163.0/app-server/session.jsonl',
  import.meta.url,
);

export function loadRecording(file: URL = RECORDED_SESSION): Recorded[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Recorded); // A recording is trusted test data.
}

type Id = number | string;

function idOf(message: Message): Id | null {
  const { id } = message;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

function methodOf(message: Message): string | null {
  return typeof message['method'] === 'string' ? message['method'] : null;
}

type Trigger =
  | { readonly kind: 'start' }
  | { readonly kind: 'call'; readonly method: string; readonly recordedId: Id | null }
  | { readonly kind: 'reply'; readonly id: Id };

interface Phase {
  readonly trigger: Trigger;
  readonly lines: Recorded[];
  consumed: boolean;
}

function triggerOf(message: Message): Trigger {
  const method = methodOf(message);
  const id = idOf(message);
  if (method !== null) {
    return { kind: 'call', method, recordedId: id };
  }
  return { kind: 'reply', id: id ?? -1 };
}

function phasesOf(recording: readonly Recorded[]): Phase[] {
  const phases: Phase[] = [{ trigger: { kind: 'start' }, lines: [], consumed: false }];
  for (const entry of recording) {
    if (entry.dir === 'send') {
      phases.push({ trigger: triggerOf(entry.msg), lines: [], consumed: false });
    } else {
      phases.at(-1)?.lines.push(entry);
    }
  }
  return phases;
}

function matches(phase: Phase, message: Message): boolean {
  if (phase.consumed) {
    return false;
  }
  const method = methodOf(message);
  const { trigger } = phase;
  if (trigger.kind === 'call') {
    return trigger.method === method;
  }
  return trigger.kind === 'reply' && method === null && trigger.id === idOf(message);
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

class FakeProcess implements AppServerProcess {
  readonly lines = new AsyncQueue<string>();
  readonly exited: Promise<AppServerExit>;
  private settle: ((exit: AppServerExit) => void) | null = null;
  private readonly server: FakeAppServer;

  constructor(server: FakeAppServer) {
    this.server = server;
    this.exited = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  readonly write = (line: string): void => {
    if (!this.lines.ended) {
      this.server.receive(this, JSON.parse(line) as Message); // The runtime writes JSON.
    }
  };

  readonly closeInput = (): void => {
    this.exit({ code: 0, signal: null, stderr: '' });
  };

  readonly kill = (): void => {
    this.server.killed += 1;
    this.exit({ code: null, signal: 'SIGTERM', stderr: '' });
  };

  /** Ends stdout, then reports the exit, in the order a real process does. */
  exit(exit: AppServerExit): void {
    if (this.lines.ended) {
      return;
    }
    this.lines.end();
    this.settle?.(exit);
  }

  print(message: Message): void {
    if (!this.lines.ended) {
      this.lines.push(JSON.stringify(message));
    }
  }
}

export class FakeAppServer {
  readonly launches: AppServerLaunch[] = [];
  /** Everything the client sent, in order. */
  readonly received: Message[] = [];
  killed = 0;
  private readonly phases: Phase[];
  private readonly ids = new Map<Id, Id>();
  private playing: Promise<void> = Promise.resolve();

  constructor(recording: readonly Recorded[]) {
    this.phases = phasesOf(recording);
  }

  readonly spawn: AppServerSpawn = (launch) => {
    this.launches.push(launch);
    const child = new FakeProcess(this);
    const start = this.phases[0];
    if (start !== undefined) {
      start.consumed = true;
      this.play(child, start);
    }
    return child;
  };

  /** The params of every request or notification the client sent with this method. */
  sent(method: string): unknown[] {
    return this.received
      .filter((message) => methodOf(message) === method)
      .map((message) => message['params']);
  }

  /** The results the client sent back for server requests, in order. */
  replies(): unknown[] {
    return this.received
      .filter((message) => methodOf(message) === null)
      .map((message) => message['result'] ?? message['error']);
  }

  receive(child: FakeProcess, message: Message): void {
    this.received.push(message);
    const phase = this.phases.find((candidate) => matches(candidate, message));
    const id = idOf(message);
    if (phase === undefined) {
      if (methodOf(message) !== null && id !== null) {
        child.print({ id, error: { code: -32_601, message: 'not in the recording' } });
      }
      return;
    }
    phase.consumed = true;
    const { trigger } = phase;
    if (trigger.kind === 'call' && trigger.recordedId !== null && id !== null) {
      this.ids.set(trigger.recordedId, id);
    }
    this.play(child, phase);
  }

  /** Writes a phase's lines one tick apart, after any phase still playing. */
  private play(child: FakeProcess, phase: Phase): void {
    this.playing = this.playing.then(async () => this.playLines(child, phase));
  }

  private async playLines(child: FakeProcess, phase: Phase): Promise<void> {
    for (const line of phase.lines) {
      await tick();
      if (line.dir === 'exit') {
        child.exit({ code: line.code, signal: null, stderr: line.stderr });
      } else {
        child.print(this.rewrite(line.msg));
      }
    }
  }

  /** A reply to the client gets the id the client used. Server requests keep their own. */
  private rewrite(message: Message): Message {
    const id = idOf(message);
    if (id === null || methodOf(message) !== null) {
      return message;
    }
    return { ...message, id: this.ids.get(id) ?? id };
  }
}
