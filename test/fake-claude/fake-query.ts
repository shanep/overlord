// An in-process stand-in for the SDK query(), for unit tests of the session
// and launcher. Tests push raw SDK messages with emit() and read back what
// the harness sent: prompts, control calls and the options it passed.

import type { SessionEvent } from '../../src/core/harness/events.js';
import type {
  QueryFunction,
  QueryOptions,
  SdkPermissionMode,
  SessionQuery,
  UserInput,
} from '../../src/core/harness/sdk-types.js';

/** Settles on a later microtask, so fakes behave like real async work. */
export async function resolved<T>(value: T): Promise<T> {
  await Promise.resolve();
  return value;
}

export async function rejected(reason: Error): Promise<never> {
  await Promise.resolve();
  throw reason;
}

type Step = { readonly kind: 'message'; readonly value: unknown } | { readonly kind: 'end' };

export type Responder = (query: FakeQuery, prompt: string) => void;

export class FakeQuery implements SessionQuery {
  readonly prompts: string[] = [];
  readonly models: (string | undefined)[] = [];
  readonly modes: SdkPermissionMode[] = [];
  interrupts = 0;
  closes = 0;
  contextUsage: unknown = { totalTokens: 50, maxTokens: 100, categories: [] };
  inputEnded = false;
  readonly options: QueryOptions;
  private readonly steps: Step[] = [];
  private failure: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(options: QueryOptions) {
    this.options = options;
    options.abortController.signal.addEventListener('abort', () => {
      this.fail(new Error('Claude Code process aborted by user'));
    });
  }

  emit(value: unknown): void {
    this.steps.push({ kind: 'message', value });
    this.poke();
  }

  end(): void {
    this.steps.push({ kind: 'end' });
    this.poke();
  }

  fail(error: Error): void {
    this.failure = error;
    this.poke();
  }

  readonly interrupt = async (): Promise<unknown> => {
    this.interrupts += 1;
    return resolved({ still_queued: [] });
  };

  readonly setModel = async (model?: string): Promise<void> => {
    this.models.push(model);
    await resolved(null);
  };

  readonly setPermissionMode = async (mode: SdkPermissionMode): Promise<void> => {
    this.modes.push(mode);
    await resolved(null);
  };

  readonly getContextUsage = async (): Promise<unknown> => resolved(this.contextUsage);

  readonly close = (): void => {
    this.closes += 1;
  };

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown, undefined, undefined> {
    for (;;) {
      const step = this.steps.shift();
      if (this.failure !== null) {
        throw this.failure;
      }
      if (step === undefined) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      } else if (step.kind === 'end') {
        return undefined;
      } else {
        yield step.value;
      }
    }
  }

  private poke(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** Reads the prompt stream the way the SDK does, for the life of the query. */
  async consume(
    prompt: AsyncIterable<UserInput, undefined, undefined>,
    responder: Responder | null,
  ): Promise<void> {
    for await (const input of prompt) {
      this.prompts.push(input.message.content);
      responder?.(this, input.message.content);
    }
    this.inputEnded = true;
    // The real CLI exits once its stdin closes and the turn is over.
    if (responder !== null) {
      this.end();
    }
  }
}

export interface FakeQueries {
  readonly queryFunction: QueryFunction;
  readonly queries: FakeQuery[];
}

export function fakeQueries(responder: Responder | null = null): FakeQueries {
  const queries: FakeQuery[] = [];
  const queryFunction: QueryFunction = (prompt, options) => {
    const query = new FakeQuery(options);
    queries.push(query);
    void query.consume(prompt, responder);
    return query;
  };
  return { queryFunction, queries };
}

export function resultMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    duration_ms: 100,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    result: 'ok',
    ...overrides,
  };
}

export async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

type PayloadMap = { readonly [E in SessionEvent as E['name']]: E['payload'] };

function isEvent<K extends keyof PayloadMap>(
  event: SessionEvent,
  name: K,
): event is SessionEvent & { readonly name: K; readonly payload: PayloadMap[K] } {
  return event.name === name;
}

/** The payloads of every event with this name, in order. */
export function payloads<K extends keyof PayloadMap>(
  events: readonly SessionEvent[],
  name: K,
): PayloadMap[K][] {
  const found: PayloadMap[K][] = [];
  for (const event of events) {
    if (isEvent(event, name)) {
      found.push(event.payload);
    }
  }
  return found;
}
