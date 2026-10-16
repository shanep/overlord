import { describe, expect, it } from 'vitest';

import type { Surface } from '../../shared/model.js';
import type { HandoffKind, SurfaceSession } from '../../shared/protocol.js';

import {
  backgroundArgs,
  backgroundedId,
  buildHandoff,
  handoffsFor,
  openDesktop,
  remoteControl,
  resumeLocal,
  teleportLocal,
} from './handoff.js';

function session(surface: Surface, overrides: Partial<SurfaceSession> = {}): SurfaceSession {
  return {
    id: 'abc-123',
    surface,
    title: 'Fix the parser',
    cwd: '/repo',
    updatedAt: 1,
    archived: false,
    handoffs: [],
    ...overrides,
  };
}

const ALL_KINDS: readonly HandoffKind[] = [
  'resume-local',
  'open-desktop',
  'teleport-local',
  'remote-control',
];

describe('background sessions', () => {
  it('starts a new session or continues one under its own id', () => {
    expect(backgroundArgs(null, {})).toStrictEqual(['--bg']);
    expect(backgroundArgs('abc-123', {})).toStrictEqual(['--bg', '--resume', 'abc-123']);
    expect(backgroundArgs(null, {}, 'Read this')).toStrictEqual(['--bg', 'Read this']);
    expect(backgroundArgs('abc-123', {}, null, true)).toStrictEqual([
      '--bg',
      '--resume',
      'abc-123',
      '--fork-session',
    ]);
    expect(backgroundArgs(null, { OVERLORD_SLOT: '2' })).toStrictEqual([
      '--bg',
      '--settings',
      '{"env":{"OVERLORD_SLOT":"2"}}',
    ]);
  });

  it('reads the short id claude --bg prints, with or without color', () => {
    expect(backgroundedId('backgrounded \u00B7 8c3efb13 (idle)\n  claude attach 8c3efb13')).toBe(
      '8c3efb13',
    );
    const bold = '\u001B[1m';
    const plain = '\u001B[22m';
    const colored = `${bold}backgrounded${plain} \u00B7 \u001B[36mab12cd34\u001B[39m`;
    expect(backgroundedId(colored)).toBe('ab12cd34');
    expect(backgroundedId('note: nothing started')).toBeNull();
  });
});

describe('single builders', () => {
  it('resumeLocal', () => {
    expect(resumeLocal('s1')).toStrictEqual({
      command: 'claude',
      args: ['--resume', 's1'],
      description: 'Resume session s1 in a terminal',
    });
    expect(resumeLocal('s1', '/opt/claude').command).toBe('/opt/claude');
  });

  it('openDesktop with and without an id', () => {
    expect(openDesktop('s1')).toStrictEqual({
      command: 'claude',
      args: ['--desktop', '--resume', 's1'],
      description: 'Open session s1 in Claude Desktop',
    });
    expect(openDesktop(null)).toStrictEqual({
      command: 'claude',
      args: ['--desktop'],
      description: 'Open Claude Desktop',
    });
    expect(openDesktop(null, 'cc').command).toBe('cc');
    expect(openDesktop('x', 'cc').command).toBe('cc');
  });

  it('teleportLocal', () => {
    expect(teleportLocal('cloud-9')).toStrictEqual({
      command: 'claude',
      args: ['--teleport', 'cloud-9'],
      description: 'Pull cloud session cloud-9 into a local terminal',
    });
    expect(teleportLocal('c', 'cc').command).toBe('cc');
  });

  it('remoteControl with a name and a session to resume', () => {
    expect(remoteControl({ name: ' laptop ', resumeId: 's1' })).toStrictEqual({
      command: 'claude',
      args: ['--remote-control', 'laptop', '--resume', 's1'],
      description: 'Resume session s1 with Remote Control',
    });
  });

  it('remoteControl with neither', () => {
    const expected = {
      command: 'claude',
      args: ['--remote-control'],
      description: 'Start a session you can steer from the web or phone',
    };
    expect(remoteControl({})).toStrictEqual(expected);
    expect(remoteControl({ name: null, resumeId: null })).toStrictEqual(expected);
    expect(remoteControl({ name: '  ' })).toStrictEqual(expected);
    expect(remoteControl({}, 'cc').command).toBe('cc');
  });

  it('remoteControl with only a name or only an id', () => {
    expect(remoteControl({ name: 'n' }).args).toStrictEqual(['--remote-control', 'n']);
    expect(remoteControl({ resumeId: 'r' }).args).toStrictEqual([
      '--remote-control',
      '--resume',
      'r',
    ]);
  });
});

describe('handoffsFor', () => {
  it('lists the handoffs each surface supports', () => {
    const local = ['resume-local', 'open-desktop', 'remote-control'];
    expect(handoffsFor({ surface: 'cli' })).toStrictEqual(local);
    expect(handoffsFor({ surface: 'sdk' })).toStrictEqual(local);
    expect(handoffsFor({ surface: 'overlord' })).toStrictEqual(local);
    expect(handoffsFor({ surface: 'desktop-code' })).toStrictEqual([
      'resume-local',
      'open-desktop',
    ]);
    expect(handoffsFor({ surface: 'cloud' })).toStrictEqual(['teleport-local']);
    expect(handoffsFor({ surface: 'cowork' })).toStrictEqual(['open-desktop']);
    expect(handoffsFor({ surface: 'claude-ai' })).toStrictEqual([]);
  });
});

describe('buildHandoff', () => {
  it('returns null for every handoff a surface does not support', () => {
    const surfaces: readonly Surface[] = ['cli', 'desktop-code', 'cloud', 'cowork', 'claude-ai'];
    for (const surface of surfaces) {
      const supported = handoffsFor({ surface });
      for (const kind of ALL_KINDS) {
        const built = buildHandoff(kind, session(surface));
        expect(built === null).toBe(!supported.includes(kind));
      }
    }
  });

  it('builds each local handoff from the session', () => {
    const cli = session('cli');
    expect(buildHandoff('resume-local', cli)).toStrictEqual(resumeLocal('abc-123'));
    expect(buildHandoff('open-desktop', cli)).toStrictEqual(openDesktop('abc-123'));
    expect(buildHandoff('remote-control', cli)).toStrictEqual(
      remoteControl({ name: 'Fix the parser', resumeId: 'abc-123' }),
    );
  });

  it('uses options for the binary and remote name', () => {
    const cli = session('sdk');
    const options = { claudeBin: 'cc', remoteName: 'phone' };
    expect(buildHandoff('resume-local', cli, options)?.command).toBe('cc');
    expect(buildHandoff('remote-control', cli, options)).toStrictEqual(
      remoteControl({ name: 'phone', resumeId: 'abc-123' }, 'cc'),
    );
    expect(buildHandoff('open-desktop', cli, options)).toStrictEqual(openDesktop('abc-123', 'cc'));
  });

  it('teleports a cloud session', () => {
    expect(buildHandoff('teleport-local', session('cloud'), { claudeBin: 'cc' })).toStrictEqual(
      teleportLocal('abc-123', 'cc'),
    );
  });

  it('opens Desktop without an id for Cowork', () => {
    expect(buildHandoff('open-desktop', session('cowork'))).toStrictEqual(openDesktop(null));
    expect(buildHandoff('open-desktop', session('desktop-code'))).toStrictEqual(
      openDesktop('abc-123'),
    );
  });
});
