import { describe, expect, it } from 'vitest';

import type { KeepAwakeLaunch } from './keep-awake.js';
import { KeepAwake, keepAwakeLaunch } from './keep-awake.js';

describe('keepAwakeLaunch', () => {
  it('blocks idle system sleep on macOS until the pid exits', () => {
    expect(keepAwakeLaunch({ platform: 'darwin', pid: 42 })).toStrictEqual({
      command: 'caffeinate',
      args: ['-i', '-w', '42'],
    });
  });

  it('holds a logind sleep lock on Linux until the pid exits', () => {
    expect(keepAwakeLaunch({ platform: 'linux', pid: 42 })).toStrictEqual({
      command: 'systemd-inhibit',
      args: [
        '--what=sleep',
        '--who=Overlord',
        '--why=Overlord is running Claude Code agents',
        '--mode=block',
        'sh',
        '-c',
        'while kill -0 42 2>/dev/null; do sleep 30; done',
      ],
    });
  });

  it('has nothing for other platforms', () => {
    expect(keepAwakeLaunch({ platform: 'win32', pid: 42 })).toBeNull();
  });
});

const LAUNCH: KeepAwakeLaunch = { command: 'caffeinate', args: ['-i'] };

function fakeSpawn(): {
  readonly spawn: (launch: KeepAwakeLaunch, onExit: () => void) => { kill: () => void };
  readonly launches: KeepAwakeLaunch[];
  readonly exits: (() => void)[];
  readonly kills: number[];
} {
  const launches: KeepAwakeLaunch[] = [];
  const exits: (() => void)[] = [];
  const kills: number[] = [];
  return {
    launches,
    exits,
    kills,
    spawn: (launch, onExit): { kill: () => void } => {
      const index = launches.length;
      launches.push(launch);
      exits.push(onExit);
      return {
        kill: (): void => {
          kills.push(index);
        },
      };
    },
  };
}

describe('KeepAwake', () => {
  it('starts one helper when enabled and kills it when disabled', () => {
    const fake = fakeSpawn();
    const awake = new KeepAwake(LAUNCH, fake.spawn);
    expect(awake.active).toBe(false);
    awake.setEnabled(true);
    awake.setEnabled(true);
    expect(fake.launches).toStrictEqual([LAUNCH]);
    expect(awake.active).toBe(true);
    awake.setEnabled(false);
    expect(fake.kills).toStrictEqual([0]);
    expect(awake.active).toBe(false);
    awake.setEnabled(false);
    expect(fake.kills).toStrictEqual([0]);
  });

  it('starts again after being turned back on', () => {
    const fake = fakeSpawn();
    const awake = new KeepAwake(LAUNCH, fake.spawn);
    awake.setEnabled(true);
    awake.setEnabled(false);
    awake.setEnabled(true);
    expect(fake.launches).toHaveLength(2);
    awake.dispose();
    expect(fake.kills).toStrictEqual([0, 1]);
  });

  it('does nothing where the platform has no helper', () => {
    const fake = fakeSpawn();
    const awake = new KeepAwake(null, fake.spawn);
    awake.setEnabled(true);
    expect(fake.launches).toStrictEqual([]);
    expect(awake.active).toBe(false);
  });

  it('forgets a helper that exits on its own and does not retry', () => {
    const fake = fakeSpawn();
    const awake = new KeepAwake(LAUNCH, fake.spawn);
    awake.setEnabled(true);
    fake.exits[0]?.();
    expect(awake.active).toBe(false);
    awake.dispose();
    expect(fake.kills).toStrictEqual([]);
  });

  it('ignores a late exit from a helper it already replaced', () => {
    const fake = fakeSpawn();
    const awake = new KeepAwake(LAUNCH, fake.spawn);
    awake.setEnabled(true);
    awake.setEnabled(false);
    awake.setEnabled(true);
    fake.exits[0]?.();
    expect(awake.active).toBe(true);
  });
});
