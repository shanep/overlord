// Synthetic projects folders in a temp dir. Never the real ~/.claude.
import { appendFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAIN } from './extract.js';
import { MAIN_NAME } from './names.js';

import type { MessageScan } from './index.js';
import { DEFAULT_MESSAGE_LIMIT, MessageIndex } from './index.js';

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

describe('messaging index', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'ovl-msg-'));
    projects = path.join(root, 'projects');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('MessageIndex', () => {
    it('scans main and subagent transcripts, newest first, with readable names', async () => {
      await writeLines(sessionFile('s1'), [
        JSON.stringify({ type: 'custom-title', customTitle: 'Audit run' }),
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
      await writeMeta('s1', 'a1', {
        agentType: 'general-purpose',
        description: 'Audit the code',
        parentAgentId: 's1',
      });
      await writeLines(agentFile('s1', 'a2'), [
        receiveLine('q3', { kind: 'coordinator' }, 'nested hello', 4),
      ]);
      await writeMeta('s1', 'a2', { agentType: 'Explore', parentAgentId: 'a1' });
      await writeLines(agentFile('s1', 'a3'), [
        receiveLine('q4', { kind: 'coordinator' }, 'hi', 5),
      ]);
      const index = new MessageIndex({ projectsDir: projects });
      const scan = await index.scan();
      // q2 is the delivery of t1, so only the send shows.
      expect(
        scan.messages.map((message) => [message.id, message.fromName, message.toName]),
      ).toStrictEqual([
        ['s1:q1', 'Audit the code', MAIN_NAME],
        ['s1:q4', MAIN_NAME, 'a3'],
        ['s1:q3', 'Audit the code', 'Explore'],
        ['s1:t2', 'Audit the code', 'Explore'],
        ['s1:t1', MAIN_NAME, 'Audit the code'],
      ]);
      expect(scan.messages[0]).toMatchObject({ from: 'a1', to: MAIN, sessionTitle: 'Audit run' });
      expect(scan.routes).toStrictEqual([]);
      expect(index.fileCount).toBe(4);
    });

    it('adds the session id to a title two sessions share', async () => {
      const cwd = JSON.stringify({ type: 'user', cwd: '/work/app', message: { content: [] } });
      await writeLines(sessionFile('s1'), [cwd, sendLine('t1', 'x', 'one', 1)]);
      await writeLines(sessionFile('s2'), [cwd, sendLine('t1', 'x', 'two', 2)]);
      await writeLines(sessionFile('s3'), [sendLine('t1', 'x', 'three', 3)]);
      const scan = await new MessageIndex({ projectsDir: projects }).scan(new Map([['s3', 'app']]));
      expect(scan.messages.map((message) => message.sessionTitle)).toStrictEqual([
        'app (s3)',
        'app (s2)',
        'app (s1)',
      ]);
    });

    it('names another session by its title once a send and its delivery match', async () => {
      const socket = 'uds:/tmp/cc-socks/42.sock';
      await writeLines(sessionFile('s1'), [
        JSON.stringify({ type: 'user', cwd: '/work/app', message: { content: [] } }),
        sendLine('t1', socket, 'hold off on pushes', 1),
      ]);
      await writeLines(sessionFile('s2'), [
        receiveLine('q1', { kind: 'peer', from: socket, name: 'app-1' }, 'hold off on pushes', 2),
        receiveLine('q2', { kind: 'peer', from: socket, name: 'app-1' }, 'all clear', 5),
      ]);
      const scan = await new MessageIndex({ projectsDir: projects }).scan(
        new Map([['s2', 'Fleet title']]),
      );
      expect(
        scan.messages.map((message) => [message.id, message.fromName, message.toName]),
      ).toStrictEqual([
        ['s2:q2', 'app', MAIN_NAME],
        ['s1:t1', MAIN_NAME, 'Fleet title'],
      ]);
      expect(scan.routes).toStrictEqual([
        { from: 'app', to: 'Fleet title', count: 2, lastAt: Date.parse(at(5)) },
      ]);
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
