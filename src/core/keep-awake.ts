// Keep the machine awake while Overlord is open, so agents keep running and
// the machine stays reachable over the network. Only system sleep is blocked:
// the display can still turn off. The helper process watches the extension
// host's pid and exits with it, so a crashed window never leaves it behind.

export interface KeepAwakeLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

export interface KeepAwakeInput {
  readonly platform: NodeJS.Platform;
  /** The process whose lifetime the sleep block follows. */
  readonly pid: number;
}

const REASON = 'Overlord is running Claude Code agents';

/** The command that blocks system sleep until pid exits, or null where Overlord has none. */
export function keepAwakeLaunch(input: KeepAwakeInput): KeepAwakeLaunch | null {
  const pid = String(input.pid);
  if (input.platform === 'darwin') {
    // -i blocks idle system sleep and leaves display sleep alone.
    return { command: 'caffeinate', args: ['-i', '-w', pid] };
  }
  if (input.platform === 'linux') {
    // A sleep lock held by logind, which also stops desktop idle suspend.
    // The shell loop holds it until pid is gone.
    return {
      command: 'systemd-inhibit',
      args: [
        '--what=sleep',
        '--who=Overlord',
        `--why=${REASON}`,
        '--mode=block',
        'sh',
        '-c',
        `while kill -0 ${pid} 2>/dev/null; do sleep 30; done`,
      ],
    };
  }
  return null;
}

export interface KeepAwakeChild {
  readonly kill: () => void;
}

/** Starts the command. onExit fires once, later, when it exits or fails to start. */
export type KeepAwakeSpawn = (launch: KeepAwakeLaunch, onExit: () => void) => KeepAwakeChild;

/** Holds the sleep block while enabled. */
export class KeepAwake {
  private child: KeepAwakeChild | null = null;

  constructor(
    private readonly launch: KeepAwakeLaunch | null,
    private readonly spawn: KeepAwakeSpawn,
  ) {}

  get active(): boolean {
    return this.child !== null;
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.stop();
      return;
    }
    if (this.child !== null || this.launch === null) {
      return;
    }
    // A missing helper (no systemd, say) just exits, and Overlord carries on
    // without the block rather than retrying.
    const child = this.spawn(this.launch, () => {
      if (this.child === child) {
        this.child = null;
      }
    });
    this.child = child;
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}
