// A runtime for any agent that speaks the Agent Client Protocol over stdio.
//
//   const runtime = acpRuntime({ command: 'copilot', args: ['--acp'] });
//   const run = runtime.start(options); // a RuntimeFacet like claudeRuntime()
//
// The spec:
//   command, args  what to run. StartOptions.executablePath replaces command,
//                  and StartOptions.extraArgs are added as --flag value.
//   env            added on top of StartOptions.env.
//   modes          Overlord permission mode id to the agent's ACP mode id.
//                  Ids not listed go to the agent as they are.
//   usage          how session/prompt reports usage: 'cumulative' (the spec,
//                  the default) or 'per_turn'.
//
// A run sends initialize, then session/new, or with resumeId session/resume
// or session/load (fork needs session/fork). The id is null until the agent
// names the session. Each send is one session/prompt, interrupt is
// session/cancel, setPermissionMode is session/set_mode (or the mode config
// option), setModel and effort use the model and thought_level config
// options, and stop kills the process. Approvals go to canUseTool with the
// choices the agent's permission options allow.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModeState,
  type SessionNotification,
} from '@agentclientprotocol/sdk';

import { errorMessage } from '../../harness/events.js';
import { AsyncQueue } from '../../harness/input-queue.js';
import type { AgentEvent, ContextUsage } from '../shared/events.js';
import type { AgentRun, RuntimeFacet, StartOptions } from '../shared/runtime.js';

import { exitError, flagArgs, startAcpProcess, type AcpExit, type AcpProcess } from './client.js';
import { configValue, inputRecord } from './content.js';
import { openSession, type OpenedSession } from './open.js';
import { permissionAnswer, permissionChoices } from './permissions.js';
import { AcpTranslator } from './translate.js';
import { UsageCounter, type UsageReport } from './usage.js';

export interface AcpAgentSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly modes?: Readonly<Record<string, string>>;
  readonly usage?: UsageReport;
}

/** How long an agent gets to exit after its input ends before it is killed. */
const EXIT_GRACE_MS = 5000;
/** How long a failed start waits for the exit, which explains it better. */
const EXIT_WAIT_MS = 1000;

type Step = { readonly event: AgentEvent } | { readonly error: Error };

interface Turn {
  readonly startedAt: number;
  readonly abort: AbortController;
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/** A call, so a check after an await is not narrowed by the one before it. */
function isCancelled(turn: Turn): boolean {
  return turn.abort.signal.aborted;
}

class AcpRun implements AgentRun {
  sessionId: string | null = null;
  private readonly options: StartOptions;
  private readonly command: string;
  private readonly steps = new AsyncQueue<Step>();
  private readonly process: AcpProcess;
  private readonly prompts: string[] = [];
  private readonly stopAbort = new AbortController();
  private readonly modeIds: Readonly<Record<string, string>>;
  private readonly modeNames: ReadonlyMap<string, string>;
  private readonly usage: UsageCounter;
  private translator: AcpTranslator | null = null;
  private modes: SessionModeState | null = null;
  /** Updates are dropped while session/load replays the old conversation. */
  private replaying = false;
  /** Updates that came before the init event, sent right after it. */
  private readonly early: SessionNotification[] = [];
  private started = false;
  private ready = false;
  private turn: Turn | null = null;
  private inputEnded = false;
  private closing = false;

  constructor(spec: AcpAgentSpec, options: StartOptions) {
    this.options = options;
    this.command = options.executablePath ?? spec.command;
    this.modeIds = spec.modes ?? {};
    this.modeNames = new Map(Object.entries(this.modeIds).map(([name, id]) => [id, name]));
    this.usage = new UsageCounter(spec.usage ?? 'cumulative', options.resumeId !== null);
    this.process = startAcpProcess(
      {
        command: this.command,
        args: [...spec.args, ...flagArgs(options.extraArgs)],
        cwd: options.cwd,
        env: { ...options.env, ...spec.env },
      },
      {
        requestPermission: async (params, signal) => this.requestPermission(params, signal),
        sessionUpdate: (params) => {
          this.sessionUpdate(params);
        },
      },
    );
  }

  private get agent(): AcpProcess['connection']['agent'] {
    return this.process.connection.agent;
  }

  /** Starts the session and watches for the agent to exit. */
  begin(): void {
    void this.watchExit();
    void this.boot();
  }

  readonly send = (text: string): void => {
    this.prompts.push(text);
    this.next();
  };

  readonly endInput = (): void => {
    this.inputEnded = true;
    this.next();
  };

  readonly interrupt = async (): Promise<void> => {
    const { turn, sessionId } = this;
    if (turn === null || isCancelled(turn) || sessionId === null) {
      return;
    }
    turn.abort.abort();
    await this.agent.notify('session/cancel', { sessionId });
  };

  readonly stop = (): void => {
    this.closing = true;
    this.stopAbort.abort();
    this.process.kill();
  };

  readonly setModel = async (model: string): Promise<void> => {
    if (!(await this.trySetConfig('model', model))) {
      throw new Error('This agent cannot change model while it runs');
    }
  };

  readonly setPermissionMode = async (mode: string): Promise<void> => {
    if (!(await this.trySetMode(this.acpMode(mode)))) {
      throw new Error('This agent cannot change permission mode while it runs');
    }
  };

  readonly contextUsage = async (): Promise<ContextUsage> => {
    await Promise.resolve();
    const window = this.translator?.window ?? null;
    if (window === null) {
      throw new Error('The agent has not reported its context use yet');
    }
    return {
      totalTokens: window.used,
      maxTokens: window.size,
      fill: window.size > 0 ? window.used / window.size : 0,
      categories: [],
    };
  };

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent, undefined, undefined> {
    for await (const step of this.steps) {
      if ('error' in step) {
        throw step.error;
      }
      yield step.event;
    }
    return undefined;
  }

  private acpMode(mode: string): string {
    return this.modeIds[mode] ?? mode;
  }

  private modeName(modeId: string): string {
    return this.modeNames.get(modeId) ?? modeId;
  }

  private emit(events: readonly AgentEvent[]): void {
    if (this.steps.ended) {
      return;
    }
    for (const event of events) {
      this.steps.push({ event });
    }
  }

  private fail(error: Error): void {
    if (this.steps.ended) {
      return;
    }
    this.steps.push({ error });
    this.steps.end();
    this.closing = true;
    this.process.kill();
  }

  private requireSession(): string {
    if (this.sessionId === null) {
      throw new Error('The agent has not started its session yet');
    }
    return this.sessionId;
  }

  /** Sets the agent's config option in a category. False when the agent has none. */
  private async trySetConfig(category: string, value: string): Promise<boolean> {
    const sessionId = this.requireSession();
    const option = configValue(this.translator?.config ?? [], category);
    if (option === null) {
      return false;
    }
    const reply = await this.agent.request('session/set_config_option', {
      sessionId,
      configId: option.id,
      value,
    });
    this.translator?.configChanged(reply.configOptions);
    return true;
  }

  /** Sets the mode with session/set_mode, or else the mode config option. */
  private async trySetMode(modeId: string): Promise<boolean> {
    const sessionId = this.requireSession();
    if (this.modes === null) {
      return this.trySetConfig('mode', modeId);
    }
    await this.agent.request('session/set_mode', { sessionId, modeId });
    this.translator?.modeSet(modeId);
    return true;
  }

  private async boot(): Promise<void> {
    try {
      const init = await this.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'overlord', title: 'Overlord', version: '1' },
      });
      const session = await openSession(this.agent, init, this.options, (on) => {
        this.replaying = on;
      });
      await this.adopt(session, init.agentInfo?.version ?? null);
    } catch (error) {
      // A request fails as soon as the agent's stdout closes, a moment before
      // the exit, and the exit says more, so give it a chance to report first.
      await Promise.race([this.process.exited, delay(EXIT_WAIT_MS, undefined, { ref: false })]);
      if (!this.closing) {
        this.fail(new Error(`${this.command} did not start a session: ${errorMessage(error)}`));
      }
    }
  }

  /** Takes the open session: applies the profile, reports init and starts prompting. */
  private async adopt(session: OpenedSession, version: string | null): Promise<void> {
    this.modes = session.modes;
    const translator = new AcpTranslator({
      newId: randomUUID,
      modeName: (modeId): string => this.modeName(modeId),
      model: configValue(session.configOptions, 'model')?.value ?? this.options.model ?? 'unknown',
      modeId:
        session.modes?.currentModeId ?? configValue(session.configOptions, 'mode')?.value ?? null,
      configOptions: session.configOptions,
    });
    this.translator = translator;
    this.sessionId = session.sessionId;
    const notices = await this.applySettings();
    const { mode } = translator;
    this.emit([
      {
        type: 'init',
        model: translator.model,
        cwd: this.options.cwd,
        tools: [],
        permissionMode: mode === null ? null : this.modeName(mode),
        mcpServers: [],
        version,
      },
      ...notices,
    ]);
    this.started = true;
    for (const notification of this.early.splice(0)) {
      this.sessionUpdate(notification);
    }
    this.ready = true;
    this.next();
  }

  /**
   * Sends the profile's model, effort and mode once the session is open. A
   * setting the agent has no option for becomes a notice, not a failure.
   */
  private async applySettings(): Promise<AgentEvent[]> {
    const { model, effort, permissionMode } = this.options;
    const missing: string[] = [];
    if (model !== null && !(await this.trySetConfig('model', model))) {
      missing.push(`model ${model}`);
    }
    if (effort !== null && !(await this.trySetConfig('thought_level', effort))) {
      missing.push(`effort ${effort}`);
    }
    if (permissionMode !== null && !(await this.trySetMode(this.acpMode(permissionMode)))) {
      missing.push(`permission mode ${permissionMode}`);
    }
    return missing.map((setting) => ({
      type: 'notice',
      text: `This agent has no setting for ${setting}, so it runs with its own`,
    }));
  }

  private sessionUpdate(notification: SessionNotification): void {
    if (this.replaying) {
      return;
    }
    const { translator } = this;
    if (translator === null || !this.started) {
      this.early.push(notification);
      return;
    }
    if (notification.sessionId === this.sessionId) {
      this.emit(translator.update(notification.update));
    }
  }

  private async requestPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const { turn, translator } = this;
    if (translator === null || turn === null || isCancelled(turn)) {
      return CANCELLED;
    }
    this.emit(translator.permissionAsked(params.toolCall));
    const result = await this.options.canUseTool(
      translator.nameOf(params.toolCall),
      inputRecord(params.toolCall.rawInput),
      {
        signal: AbortSignal.any([signal, turn.abort.signal, this.stopAbort.signal]),
        toolUseId: params.toolCall.toolCallId,
        agentId: null,
        choices: permissionChoices(params.options),
      },
    );
    // The spec answers every open request with cancelled once the turn is cancelled.
    if (isCancelled(turn)) {
      return CANCELLED;
    }
    const answer = permissionAnswer(result, params.options);
    if (answer.cancelTurn) {
      await this.interrupt();
    }
    return { outcome: answer.outcome };
  }

  /** Starts the next prompt when the agent is idle, or ends the run when input is done. */
  private next(): void {
    if (!this.ready || this.turn !== null || this.closing) {
      return;
    }
    const text = this.prompts.shift();
    if (text !== undefined) {
      const turn: Turn = { startedAt: Date.now(), abort: new AbortController() };
      this.turn = turn;
      void this.prompt(turn, text);
      return;
    }
    if (this.inputEnded) {
      this.closing = true;
      this.process.endInput();
      setTimeout(() => {
        this.process.kill();
      }, EXIT_GRACE_MS).unref();
    }
  }

  private async prompt(turn: Turn, text: string): Promise<void> {
    const sessionId = this.requireSession();
    try {
      const reply = await this.agent.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      const cancelled = reply.stopReason === 'cancelled';
      this.emit(
        this.translator?.endTurn({
          stopReason: reply.stopReason,
          usage: this.usage.turn(reply.usage, cancelled),
          durationMs: Date.now() - turn.startedAt,
        }) ?? [],
      );
    } catch (error) {
      if (!this.closing) {
        this.emit(
          this.translator?.failTurn(errorMessage(error), Date.now() - turn.startedAt) ?? [],
        );
      }
    } finally {
      this.turn = null;
      this.next();
    }
  }

  private async watchExit(): Promise<void> {
    const exit: AcpExit = await this.process.exited;
    if (this.closing || (exit.error === null && exit.code === 0)) {
      this.steps.end();
      return;
    }
    this.fail(exitError(this.command, exit, this.process.stderr()));
  }
}

/** A runtime that drives one ACP agent command. */
export function acpRuntime(spec: AcpAgentSpec): RuntimeFacet {
  return {
    start: (options): AgentRun => {
      const run = new AcpRun(spec, options);
      run.begin();
      return run;
    },
    permissionSource: 'runtime',
  };
}
