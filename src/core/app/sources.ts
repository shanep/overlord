// The live data sources: the transcript watcher always, the hook server when
// hooks are installed, and the OTLP receiver when telemetry is on in user
// settings. Every start and stop runs through one queue, so a settings change
// and a dispose can never interleave.

import type { EventBus } from '../bus.js';
import { isInstalled } from '../hooks/install.js';
import { HookServer } from '../hooks/server.js';
import { TelemetryDecoder } from '../otel/decode.js';
import { OtlpReceiver } from '../otel/receiver.js';
import type { ClaudePaths } from '../paths.js';
import type { WatchFactory } from '../transcripts/watcher.js';
import { TranscriptWatcher } from '../transcripts/watcher.js';

import { messageOf } from './errors.js';
import type { HostPort } from './host-port.js';
import type { PermissionHub } from './permissions.js';
import { telemetryActive, userSettingsEnv } from './settings-view.js';
import type { ContextViews } from './views/context.js';

export interface SourcesDeps {
  readonly paths: ClaudePaths;
  readonly host: HostPort;
  readonly bus: EventBus;
  readonly clock: () => number;
  readonly platform: NodeJS.Platform;
  readonly socketPath: string;
  /** Null turns fs.watch off, leaving the watcher's poll. Undefined uses fs.watch. */
  readonly watchFactory: WatchFactory | null | undefined;
  readonly permissions: PermissionHub;
  readonly context: ContextViews;
  readonly report: (source: string, message: string) => void;
  readonly notify: () => void;
}

/** prepareSocketPath says this when another window's hook server owns the socket. */
const SOCKET_TAKEN = 'already listening';

export class Sources {
  private readonly deps: SourcesDeps;
  private queue: Promise<void> = Promise.resolve();
  private watcher: TranscriptWatcher | null = null;
  private hooks: HookServer | null = null;
  private offInstructions: (() => void) | null = null;
  private receiver: OtlpReceiver | null = null;
  private observer = false;
  private stopped = false;

  constructor(deps: SourcesDeps) {
    this.deps = deps;
  }

  /** True when another Overlord window owns the hook socket, so this one runs without hooks. */
  get observerMode(): boolean {
    return this.observer;
  }

  /** The port the OTLP receiver listens on, or null when it is not running. */
  get telemetryPort(): number | null {
    return this.receiver?.port ?? null;
  }

  async startWatcher(): Promise<void> {
    return this.enqueue(async () => {
      const { deps } = this;
      const watcher = new TranscriptWatcher({
        projectsDir: deps.paths.projectsDir,
        bus: deps.bus,
        activeWindowMs: deps.host.settings.activeWindowMinutes * 60_000,
        now: deps.clock,
        ...(deps.watchFactory === undefined ? {} : { watchFactory: deps.watchFactory }),
      });
      this.watcher = watcher;
      await watcher.start();
    });
  }

  async refreshWatcher(): Promise<void> {
    await this.watcher?.refresh();
  }

  /** Loads one session's transcript, even one outside the active window. */
  async openTranscript(sessionId: string): Promise<boolean> {
    return (await this.watcher?.open(sessionId)) ?? false;
  }

  /** Starts or stops the hook server and the OTLP receiver to match the settings file. */
  async sync(): Promise<void> {
    return this.enqueue(async () => {
      await this.syncHooks();
      await this.syncTelemetry();
    });
  }

  /** Stops everything once the operations already queued are done. */
  async stop(): Promise<void> {
    this.stopped = true;
    return this.enqueue(async () => {
      this.watcher?.dispose();
      this.watcher = null;
      await this.stopHooks();
      await this.stopReceiver();
    }, true);
  }

  private async enqueue(task: () => Promise<void>, always = false): Promise<void> {
    const previous = this.queue;
    const next = (async (): Promise<void> => {
      await previous;
      if (always || !this.stopped) {
        await task();
      }
    })();
    this.queue = next;
    return next;
  }

  private async syncHooks(): Promise<void> {
    let installed = false;
    try {
      installed = await isInstalled({ settingsFile: this.deps.paths.userSettings });
    } catch (error) {
      this.deps.report('hooks', messageOf(error));
    }
    if (installed && this.hooks === null) {
      await this.startHooks();
    } else if (!installed) {
      this.observer = false;
      await this.stopHooks();
    }
  }

  private async startHooks(): Promise<void> {
    const { deps } = this;
    const server = new HookServer({
      socketPath: deps.socketPath,
      bus: deps.bus,
      rules: deps.permissions.rules(),
      audit: deps.permissions.audit,
      holdMs: deps.host.settings.holdTimeoutSeconds * 1000,
      now: deps.clock,
      platform: deps.platform,
    });
    try {
      await server.start();
    } catch (error) {
      const message = messageOf(error);
      this.observer = message.includes(SOCKET_TAKEN);
      if (!this.observer) {
        deps.report('hooks', message);
      }
      deps.notify();
      return;
    }
    this.observer = false;
    this.hooks = server;
    this.offInstructions = server.onInstructionLoaded((event) => {
      deps.context.addObserved(event);
    });
    deps.permissions.attachHooks(server);
  }

  private async stopHooks(): Promise<void> {
    const server = this.hooks;
    if (server === null) {
      return;
    }
    this.hooks = null;
    this.offInstructions?.();
    this.offInstructions = null;
    this.deps.permissions.attachHooks(null);
    await server.stop();
  }

  private async syncTelemetry(): Promise<void> {
    const active = telemetryActive(await userSettingsEnv(this.deps.paths));
    if (active && this.receiver === null) {
      await this.startReceiver();
    } else if (!active) {
      await this.stopReceiver();
    }
  }

  private async startReceiver(): Promise<void> {
    const { deps } = this;
    const port = deps.host.settings.telemetryPort;
    const decoder = new TelemetryDecoder({ bus: deps.bus, now: deps.clock });
    const receiver = new OtlpReceiver({
      port,
      onExport: (signal, body): void => {
        decoder.ingest(signal, body);
      },
      onError: (message): void => {
        deps.report('otel', message);
      },
    });
    try {
      await receiver.start();
    } catch (error) {
      deps.report('otel', `Cannot listen on port ${String(port)}: ${messageOf(error)}`);
      return;
    }
    this.receiver = receiver;
    deps.notify();
  }

  private async stopReceiver(): Promise<void> {
    const receiver = this.receiver;
    this.receiver = null;
    await receiver?.stop();
  }
}
