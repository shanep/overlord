// A value loaded in the background. Views read it synchronously; the first
// read starts a load, and every finished load tells the panels to re-render.

import { messageOf } from './errors.js';

export interface AsyncValueOptions<T> {
  /** Shows up in errors, for example "usage". */
  readonly name: string;
  readonly initial: T;
  readonly load: () => Promise<T>;
  readonly onUpdate: () => void;
  readonly onError: (source: string, message: string) => void;
}

export class AsyncValue<T> {
  private current: T;
  private started = false;
  private running: Promise<void> | null = null;
  private again = false;
  private readonly options: AsyncValueOptions<T>;

  constructor(options: AsyncValueOptions<T>) {
    this.options = options;
    this.current = options.initial;
  }

  /** The latest value. The first read starts a load. */
  get value(): T {
    if (!this.started) {
      void this.refresh();
    }
    return this.current;
  }

  /** The latest value, without starting a load. */
  peek(): T {
    return this.current;
  }

  /** Load again. A call made while a load runs gets one more load after it. */
  async refresh(): Promise<void> {
    this.started = true;
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  private async loop(): Promise<void> {
    let more = true;
    while (more) {
      this.again = false;
      await this.loadOnce();
      more = this.wantsMore();
    }
  }

  private wantsMore(): boolean {
    return this.again;
  }

  private async loadOnce(): Promise<void> {
    try {
      this.current = await this.options.load();
      this.options.onUpdate();
    } catch (error) {
      this.options.onError(this.options.name, messageOf(error));
    }
  }
}
