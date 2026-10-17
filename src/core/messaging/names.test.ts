import { describe, expect, it } from 'vitest';

import type { ExtractedMessage, RawMessage } from './extract.js';
import { BROADCAST, MAIN } from './extract.js';
import type { Directory } from './names.js';
import { EVERYONE, MAIN_NAME, nameMessages } from './names.js';

const AGENT = 'a0123456789abcdef0';

const directory: Directory = {
  sessionTitle: (sessionId) => `Title ${sessionId}`,
  agentName: (sessionId, agentId) =>
    sessionId === 's1' && agentId === 'helper' ? 'Check the build' : null,
};

function entry(message: Partial<RawMessage>, key: string, routine = false): ExtractedMessage {
  return {
    message: {
      id: key,
      at: 0,
      sessionId: 's1',
      from: MAIN,
      to: 'helper',
      kind: 'send',
      preview: '',
      blocked: false,
      ...message,
    },
    textKey: key,
    routine,
    senderName: null,
  };
}

function names(entries: readonly ExtractedMessage[]): string[][] {
  return nameMessages(entries, directory).messages.map((message) => [
    message.id,
    message.fromName,
    message.toName,
  ]);
}

describe('nameMessages', () => {
  it('names the main thread, broadcasts, described agents and the session', () => {
    const { messages } = nameMessages(
      [
        entry({ id: '1' }, 'k1'),
        entry({ id: '2', from: 'helper', to: BROADCAST, kind: 'broadcast' }, 'k2'),
      ],
      directory,
    );
    expect(messages.map((message) => [message.fromName, message.toName])).toStrictEqual([
      [MAIN_NAME, 'Check the build'],
      ['Check the build', EVERYONE],
    ]);
    expect(messages[0]?.sessionTitle).toBe('Title s1');
  });

  it('falls back to a short agent id, a socket pid, or the address itself', () => {
    expect(
      names([
        entry({ id: '1', to: AGENT }, 'k1'),
        entry({ id: '2', to: 'uds:/tmp/cc-socks/4321.sock' }, 'k2'),
        entry({ id: '3', to: 'api-worker' }, 'k3'),
        entry({ id: '5', to: 'uds:/tmp/pipe.sock' }, 'k5'),
        entry({ id: '6', to: '/tmp/cc-socks/12.sock' }, 'k6'),
        entry({ id: '4', sessionId: 's2', from: 'helper', to: MAIN, kind: 'hand-back' }, 'k4'),
      ]),
    ).toStrictEqual([
      ['1', MAIN_NAME, 'Agent a0123456'],
      ['2', MAIN_NAME, 'Session with pid 4321'],
      ['3', MAIN_NAME, 'api-worker'],
      ['5', MAIN_NAME, 'uds:/tmp/pipe.sock'],
      ['6', MAIN_NAME, '/tmp/cc-socks/12.sock'],
      ['4', 'helper', MAIN_NAME],
    ]);
  });

  it('names an agent the directory does not know from a notice that names it', () => {
    const notice: ExtractedMessage = {
      ...entry({ id: 'n', from: AGENT, to: MAIN, kind: 'task-notification' }, 'n', true),
      senderName: 'Map the repo',
    };
    expect(
      names([
        notice,
        entry({ id: 'm', to: AGENT }, 'm'),
        entry({ id: 'o', sessionId: 's2', to: AGENT }, 'o'),
      ]),
    ).toStrictEqual([
      ['n', 'Map the repo', MAIN_NAME],
      ['m', MAIN_NAME, 'Map the repo'],
      ['o', MAIN_NAME, 'Agent a0123456'],
    ]);
  });

  it('keeps one copy of a message whose delivery matches its send', () => {
    expect(
      names([
        entry({ id: 'send', to: 'helper' }, 'same'),
        entry({ id: 'delivery', from: MAIN, to: 'helper', kind: 'receive' }, 'same'),
        entry({ id: 'other', from: 'helper', to: MAIN, kind: 'receive' }, 'different'),
      ]).map(([id]) => id),
    ).toStrictEqual(['send', 'other']);
  });

  it('drops a routine notice when the agent handed back, and keeps the rest', () => {
    const notice = (
      id: string,
      from: string,
      routine: boolean,
      sessionId = 's1',
    ): ExtractedMessage =>
      entry({ id, sessionId, from, to: MAIN, kind: 'task-notification' }, id, routine);
    expect(
      names([
        entry({ id: 'report', from: AGENT, to: MAIN, kind: 'hand-back' }, 'report'),
        notice('finished', AGENT, true),
        notice('failed', AGENT, false),
        notice('alone', 'a1111111111111111', true),
        notice('elsewhere', AGENT, true, 's2'),
      ]).map(([id]) => id),
    ).toStrictEqual(['report', 'failed', 'alone', 'elsewhere']);
  });

  it('names both sides of a cross-session message by session title', () => {
    const socket = 'uds:/tmp/cc-socks/9.sock';
    const result = nameMessages(
      [
        entry({ id: 'send', to: socket, at: 1 }, 'hello'),
        entry(
          { id: 'delivery', sessionId: 's2', from: 'web-1', to: MAIN, kind: 'receive' },
          'hello',
        ),
        entry({ id: 'reply', sessionId: 's2', to: 'web-1', at: 3 }, 'reply'),
        entry(
          { id: 'later', sessionId: 's2', from: 'web-1', to: MAIN, kind: 'receive', at: 4 },
          'later',
        ),
      ],
      directory,
    );
    expect(
      result.messages.map((message) => [message.id, message.toName, message.fromName]),
    ).toStrictEqual([
      ['send', 'Title s2', MAIN_NAME],
      ['reply', 'Title s1', MAIN_NAME],
      ['later', MAIN_NAME, 'Title s1'],
    ]);
    expect(result.routes).toStrictEqual([
      { from: 'Title s1', to: 'Title s2', count: 2, lastAt: 4 },
      { from: 'Title s2', to: 'Title s1', count: 1, lastAt: 3 },
    ]);
  });

  it('learns nothing from a match inside one session', () => {
    expect(
      names([
        entry({ id: 'send', to: 'peer' }, 'k'),
        entry({ id: 'delivery', from: 'peer', to: MAIN, kind: 'receive' }, 'k'),
        entry({ id: 'next', to: 'peer' }, 'k2'),
      ]),
    ).toStrictEqual([
      ['send', MAIN_NAME, 'peer'],
      ['next', MAIN_NAME, 'peer'],
    ]);
  });

  it('counts only traffic between sessions, busiest then newest first', () => {
    const { routes } = nameMessages(
      [
        entry({ id: '1', to: 'helper' }, 'k1'),
        entry({ id: '2', to: AGENT }, 'k2'),
        entry({ id: '3', from: MAIN, to: 'helper', kind: 'receive' }, 'k3'),
        entry({ id: '4', to: 'x', at: 2 }, 'k4'),
        entry({ id: '5', to: 'y', at: 5 }, 'k5'),
        entry({ id: '6', to: 'y', at: 1 }, 'k6'),
        entry({ id: '7', from: 'x', to: MAIN, kind: 'receive', at: 9 }, 'k7'),
        entry({ id: '8', from: AGENT, to: MAIN, kind: 'hand-back' }, 'k8'),
      ],
      directory,
    );
    expect(routes).toStrictEqual([
      { from: 'Title s1', to: 'y', count: 2, lastAt: 5 },
      { from: 'x', to: 'Title s1', count: 1, lastAt: 9 },
      { from: 'Title s1', to: 'x', count: 1, lastAt: 2 },
    ]);
  });

  it('keeps routes apart even when the names contain separators', () => {
    const titled: Directory = { ...directory, sessionTitle: (sessionId) => sessionId };
    const { routes } = nameMessages(
      [
        entry({ id: '1', sessionId: 'a:b', to: 'c' }, 'k1'),
        entry({ id: '2', sessionId: 'a', to: 'b:c' }, 'k2'),
      ],
      titled,
    );
    expect(routes).toHaveLength(2);
  });
});
