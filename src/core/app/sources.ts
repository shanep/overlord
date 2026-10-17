// The live data sources: a tailing watcher for every agent with an observer,
// the hook server when hooks are installed, and the OTLP receiver when
// telemetry is on in user settings. Every start and stop runs through one queue, so a settings change
// and a dispose can never interleave.

import { agents } from '../agents/index.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { WatchFactory } from '../agents/shared/tailing-watcher.js';
import { TailingWatcher } from '../agents/shared/tailing-watcher.js';
import type { AgentPlace, ShellEnv } from '../agents/types.js';
import type { EventBus } from '../bus.js';
import { isInstalled } from '../hooks/install.js';
import type { HookEventOf } from '../hooks/normalized.js';
import type { Adviser } from '../hooks/server.js';
import { HookServer } from '../hooks/server.js';
import { installStableRelay } from '../hooks/stable-relay.js';
import { TelemetryDecoder } from '../otel/decode.js';
import { OtlpReceiver } from '../otel/receiver.js';
import type { ClaudePaths } from '../paths.js';

import { dialectsOf, exportingAgents, hookedAgents, telemetryDecoder } from './agent-talk.js';
import { messageOf } from './errors.js';
import type { HostPort } from './host-port.js';
import type { PermissionHub } from './permissions.js';
import { telemetryActive, userSettingsEnv } from './settings-view.js';
import type { ContextViews } from './views/context.js';

export interface SourcesDeps {
  readonly paths: ClaudePaths;
  /** Where observers look for variables that move an agent's folders. */
  readonly env: ShellEnv;
  /** The agents to watch. Every one with an observer gets a watcher. */
  readonly agents?: AgentRegistry;
  readonly host: HostPort;
  readonly bus: EventBus;
  readonly clock: () => number;
  readonly platform: NodeJS.Platform;
  readonly socketPath: string;
  /** Null turns fs.watch off, leaving the watchers' poll. Undefined uses fs.watch. */
  readonly watchFactory: WatchFactory | null | undefined;
  readonly permissions: PermissionHub;
  readonly context: ContextViews;
  /** Answers hooks for the coordinator, or null to leave them unanswered. */
  readonly advise?: Adviser | null;
  readonly report: (source: string, message: string) => void;
  readonly notify: () => void;
  /** The SessionStart note for a new session, or null for none. */
  readonly sessionContext: (event: HookEventOf<'session-start'>) => string | null;
}

/** prepareSocketPath says this when another window's hook server owns the socket. */
const SOCKET_TAKEN = 'already listening';

export class Sources {
  private readonly deps: SourcesDeps;
  private queue: Promise<void> = Promise.resolve();
  private watchers: TailingWatcher[] = [];
  /** Session ids to hold in the fleet, kept here too in case they arrive before the watchers. */
  private kept: readonly string[] = [];
  private finished: readonly string[] = [];
  /** Sessions open in a terminal, held for as long as the window shows them. */
  private viewed: readonly string[] = [];
  /** Sessions the Launcher started, held until removed by hand. */
  private launched: readonly string[] = [];
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

  /** Starts one watcher per agent observer, in registry order. */
  async startWatcher(): Promise<void> {
    return this.enqueue(async () => {
      const { deps } = this;
      const context: AgentPlace = { home: deps.paths.home, env: deps.env, claude: deps.paths };
      for (const adapter of (deps.agents ?? agents).list()) {
        if (adapter.observer === undefined) {
          continue;
        }
        const watcher = new TailingWatcher({
          observer: adapter.observer.create(context),
          bus: deps.bus,
          activeWindowMs: deps.host.settings.activeWindowMinutes * 60_000,
          idleWindowMs: deps.host.settings.idleMinutes * 60_000,
          now: deps.clock,
          ...(deps.watchFactory === undefined ? {} : { watchFactory: deps.watchFactory }),
        });
        this.watchers.push(watcher);
        await watcher.start();
        await watcher.keep(this.held(), this.finished);
      }
    });
  }

  private held(): string[] {
    return [...new Set([...this.kept, ...this.viewed, ...this.launched])];
  }

  /** Holds the sessions the Launcher started however long they have been quiet, until removed by hand. */
  async keepLaunched(sessionIds: readonly string[]): Promise<void> {
    this.launched = sessionIds;
    await this.keepAll();
  }

  /** Drops a session from the fleet until its transcript changes again. */
  async dismissTranscript(sessionId: string): Promise<void> {
    for (const watcher of this.watchers) {
      await watcher.dismiss(sessionId);
    }
  }

  /**
   * Holds these sessions' transcripts in the fleet however long they have
   * been quiet, and the finished ones until the active window passes.
   */
  async keepTranscripts(
    sessionIds: readonly string[],
    finished: readonly string[] = [],
  ): Promise<void> {
    this.kept = sessionIds;
    this.finished = finished;
    await this.keepAll();
  }

  /**
   * Holds the sessions open in a terminal however long they have been quiet,
   * in place of the ones held before. Closing the window lets one age out.
   */
  async keepViewed(sessionIds: readonly string[]): Promise<void> {
    this.viewed = sessionIds;
    await this.keepAll();
  }

  private async keepAll(): Promise<void> {
    for (const watcher of this.watchers) {
      await watcher.keep(this.held(), this.finished);
    }
  }

  async refreshWatcher(): Promise<void> {
    for (const watcher of this.watchers) {
      await watcher.refresh();
    }
  }

  /** Loads one session's transcript, even one outside the active window. The first agent that has it wins. */
  async openTranscript(sessionId: string): Promise<boolean> {
    for (const watcher of this.watchers) {
      if (await watcher.open(sessionId)) {
        return true;
      }
    }
    return false;
  }

  /** True while the session's transcript has a turn open or a tool call without a result. */
  sessionBusy(sessionId: string): boolean {
    return this.watchers.some((watcher) => watcher.busy(sessionId));
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
      for (const watcher of this.watchers) {
        watcher.dispose();
      }
      this.watchers = [];
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
    const { deps } = this;
    let installed = false;
    try {
      installed = await isInstalled({ settingsFile: deps.paths.userSettings });
    } catch (error) {
      deps.report('hooks', messageOf(error));
    }
    const others = await hookedAgents(deps.agents ?? agents, deps.paths, deps.env);
    if (others.length > 0) {
      await this.refreshRelay();
    }
    installed ||= others.length > 0;
    if (installed && this.hooks === null) {
      await this.startHooks();
    } else if (!installed) {
      this.observer = false;
      await this.stopHooks();
    }
  }

  /** Puts this version's relay where the other agents' hook commands point. */
  private async refreshRelay(): Promise<void> {
    try {
      await installStableRelay(this.deps.host.extensionPath, this.deps.paths.home);
    } catch (error) {
      this.deps.report('hooks', `Cannot update the hook relay: ${messageOf(error)}`);
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
      sessionContext: deps.sessionContext,
      advise: deps.advise ?? null,
      dialects: dialectsOf(deps.agents ?? agents),
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
    const { deps } = this;
    const exporting = await exportingAgents(deps.agents ?? agents, deps.paths, deps.env);
    const active = telemetryActive(await userSettingsEnv(deps.paths)) || exporting.length > 0;
    if (active && this.receiver === null) {
      await this.startReceiver();
    } else if (!active) {
      await this.stopReceiver();
    }
  }

  private async startReceiver(): Promise<void> {
    const { deps } = this;
    const port = deps.host.settings.telemetryPort;
    const decoder = new TelemetryDecoder({
      bus: deps.bus,
      now: deps.clock,
      decode: telemetryDecoder(deps.agents ?? agents),
    });
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
