// Synthetic projects folders in a temp dir. Never the real ~/.claude.
import { appendFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentMessage } from '../../shared/protocol.js';

import type { ExtractedMessage } from './extract.js';
import { MAIN } from './extract.js';

import type { MessageScan } from './index.js';
import { buildRoutes, DEFAULT_MESSAGE_LIMIT, MessageIndex } from './index.js';

function ids(scan: MessageScan): string[] {
  return scan.messages.map((message) => message.id);
}

let root: string;
let projects: string;

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

function sendLine(id: string, to: string, text: string, seconds: number): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${id}`,
    timestamp: at(seconds),
    message: {
      content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: text } }],
    },
  });
}

function receiveLine(uuid: string, origin: unknown, text: string, seconds: number): string {
  return JSON.stringify({
    type: 'attachment',
    uuid,
    timestamp: at(seconds),
    attachment: { type: 'queued_command', prompt: text, origin },
  });
}

async function writeLines(file: string, lines: readonly string[]): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.map((line) => `${line}\n`).join(''));
  return file;
}

function sessionFile(session: string): string {
  return path.join(projects, '-work-app', `${session}.jsonl`);
}

function agentFile(session: string, agent: string): string {
  return path.join(projects, '-work-app', session, 'subagents', `agent-${agent}.jsonl`);
}

async function writeMeta(session: string, agent: string, meta: unknown): Promise<void> {
  const file = agentFile(session, agent).replace(/\.jsonl$/u, '.meta.json');
  await writeFile(file, JSON.stringify(meta));
}

function entry(message: Partial<AgentMessage>, key: string): ExtractedMessage {
  return {
    message: {
      id: 'x',
      at: 0,
      sessionId: 's',
      from: MAIN,
      to: 'a1',
      kind: 'send',
      preview: '',
      blocked: false,
      ...message,
    },
    textKey: key,
  };
}

describe('messaging index', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'ovl-msg-'));
    projects = path.join(root, 'projects');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('buildRoutes', () => {
    it('counts each pair, keeps the latest time, and sorts busiest first', () => {
      const routes = buildRoutes([
        entry({ id: '1', at: 5 }, 'k1'),
        entry({ id: '2', at: 9 }, 'k2'),
        entry({ id: '3', at: 7 }, 'k3'),
        entry({ id: '4', from: 'a1', to: MAIN, kind: 'hand-back', at: 3 }, 'k4'),
        entry({ id: '5', from: 'a2', to: MAIN, kind: 'hand-back', at: 4 }, 'k5'),
      ]);
      expect(routes).toStrictEqual([
        { from: MAIN, to: 'a1', count: 3, lastAt: 9 },
        { from: 'a2', to: MAIN, count: 1, lastAt: 4 },
        { from: 'a1', to: MAIN, count: 1, lastAt: 3 },
      ]);
    });

    it('does not count a delivery twice when its send is known', () => {
      const routes = buildRoutes([
        entry({ id: '1', kind: 'broadcast', to: '*' }, 'same'),
        entry({ id: '2', kind: 'send', to: 'peer' }, 'sent'),
        entry({ id: '3', kind: 'receive', from: MAIN, to: 'a1' }, 'sent'),
        entry({ id: '4', kind: 'receive', from: 'p', to: MAIN }, 'same'),
        entry({ id: '5', kind: 'hand-back', from: 'a1', to: MAIN }, 'sent'),
      ]);
      expect(routes.map((route) => [route.from, route.to, route.count])).toStrictEqual([
        [MAIN, '*', 1],
        [MAIN, 'peer', 1],
        ['p', MAIN, 1],
        ['a1', MAIN, 1],
      ]);
    });

    it('keeps pairs apart even when the names contain separators', () => {
      const routes = buildRoutes([
        entry({ id: '1', from: 'a:b', to: 'c' }, 'k1'),
        entry({ id: '2', from: 'a', to: 'b:c' }, 'k2'),
      ]);
      expect(routes).toHaveLength(2);
    });
  });

  describe('MessageIndex', () => {
    it('scans main and subagent transcripts, newest first', async () => {
      await writeLines(sessionFile('s1'), [
        sendLine('t1', 'a1', 'start the audit', 1),
        receiveLine(
          'q1',
          { kind: 'peer', from: 'a1', senderTaskId: 'a1', handback: true },
          'done',
          9,
        ),
      ]);
      await writeLines(agentFile('s1', 'a1'), [
        receiveLine('q2', { kind: 'coordinator' }, 'start the audit', 2),
        sendLine('t2', 'a2', 'ask a sibling', 3),
      ]);
      await writeMeta('s1', 'a1', { agentType: 'general-purpose', parentAgentId: 's1' });
      await writeLines(agentFile('s1', 'a2'), [
        receiveLine('q3', { kind: 'coordinator' }, 'nested hello', 4),
      ]);
      await writeMeta('s1', 'a2', { agentType: 'Explore', parentAgentId: 'a1' });
      await writeLines(agentFile('s1', 'a3'), [
        receiveLine('q4', { kind: 'coordinator' }, 'hi', 5),
      ]);
      const index = new MessageIndex({ projectsDir: projects });
      const scan = await index.scan();
      expect(scan.messages.map((message) => [message.id, message.from, message.to])).toStrictEqual([
        ['s1:q1', 'a1', MAIN],
        ['s1:q4', MAIN, 'a3'],
        ['s1:q3', 'a1', 'a2'],
        ['s1:t2', 'a1', 'a2'],
        ['s1:q2', MAIN, 'a1'],
        ['s1:t1', MAIN, 'a1'],
      ]);
      // q2 repeats the text of t1, so only the send counts on that route.
      expect(scan.routes).toStrictEqual([
        { from: 'a1', to: 'a2', count: 2, lastAt: Date.parse(at(4)) },
        { from: 'a1', to: MAIN, count: 1, lastAt: Date.parse(at(9)) },
        { from: MAIN, to: 'a3', count: 1, lastAt: Date.parse(at(5)) },
        { from: MAIN, to: 'a1', count: 1, lastAt: Date.parse(at(1)) },
      ]);
      expect(index.fileCount).toBe(4);
    });

    it('rereads a file only when its size or time changes, and forgets removed files', async () => {
      const file = await writeLines(sessionFile('s1'), [sendLine('t1', 'a1', 'one', 1)]);
      const other = await writeLines(sessionFile('s2'), [sendLine('t1', 'a1', 'two', 2)]);
      const index = new MessageIndex({ projectsDir: projects });
      expect(ids(await index.scan())).toStrictEqual(['s2:t1', 's1:t1']);
      // Same size and time: the cached messages stand, even though the text changed.
      const stamp = new Date(Date.UTC(2026, 0, 1));
      await utimes(file, stamp, stamp);
      await index.scan();
      await writeFile(file, `${sendLine('t9', 'a1', 'one', 1)}\n`);
      await utimes(file, stamp, stamp);
      expect(ids(await index.scan())).toContain('s1:t1');
      await appendFile(file, `${sendLine('t2', 'a1', 'later', 3)}\n`);
      expect(ids(await index.scan())).toStrictEqual(['s1:t2', 's2:t1', 's1:t9']);
      await rm(other);
      const scan = await index.scan();
      expect(scan.messages.map((message) => message.id)).toStrictEqual(['s1:t2', 's1:t9']);
      expect(index.fileCount).toBe(1);
    });

    it('caps the message list but counts every route', async () => {
      await writeLines(sessionFile('s1'), [
        sendLine('t1', 'a1', 'one', 1),
        sendLine('t2', 'a1', 'two', 2),
        sendLine('t3', 'a1', 'three', 3),
      ]);
      const scan = await new MessageIndex({ projectsDir: projects, limit: 2 }).scan();
      expect(scan.messages.map((message) => message.id)).toStrictEqual(['s1:t3', 's1:t2']);
      expect(scan.routes).toMatchObject([{ count: 3 }]);
      expect(DEFAULT_MESSAGE_LIMIT).toBe(500);
    });

    it('breaks time ties by id and keeps one copy of a repeated id', async () => {
      await writeLines(sessionFile('s1'), [
        sendLine('tb', 'a1', 'b', 1),
        sendLine('ta', 'a1', 'a', 1),
        sendLine('ta', 'a1', 'a again', 1),
      ]);
      const scan = await new MessageIndex({ projectsDir: projects }).scan();
      expect(scan.messages.map((message) => message.id)).toStrictEqual(['s1:ta', 's1:tb']);
    });

    it('skips a subagent transcript that cannot be read', async () => {
      await writeLines(sessionFile('s1'), [sendLine('t1', 'a1', 'one', 1)]);
      const dangling = agentFile('s1', 'gone');
      await mkdir(path.dirname(dangling), { recursive: true });
      await symlink(path.join(root, 'missing.jsonl'), dangling);
      const index = new MessageIndex({ projectsDir: projects });
      expect(ids(await index.scan())).toHaveLength(1);
      expect(index.fileCount).toBe(1);
    });

    it('gives nothing for a missing projects folder', async () => {
      const scan = await new MessageIndex({ projectsDir: path.join(root, 'nope') }).scan();
      expect(scan).toStrictEqual({ messages: [], routes: [] });
    });
  });
});
