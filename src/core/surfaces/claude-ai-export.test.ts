import path from 'node:path';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  importClaudeAiExport,
  parseClaudeAiExport,
  resolveExportFile,
} from './claude-ai-export.js';
import { makeScratchHome } from './test-helpers/scratch-home.js';

const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-01T11:00:00.000Z';
const T3 = '2026-03-02T09:30:00.000Z';

const CONVERSATION = {
  uuid: 'chat-1',
  name: '  Trip planning  ',
  summary: 'A summary',
  created_at: T1,
  updated_at: T3,
  account: { uuid: 'acct' },
  chat_messages: [
    {
      uuid: 'm1',
      text: 'Hello there',
      content: [{ type: 'text', text: 'ignored when text is set' }],
      sender: 'human',
      created_at: T1,
      attachments: [{ file_name: 'notes.txt', extracted_content: 'x' }],
      files: [{ file_name: 'photo.png' }],
    },
    {
      uuid: 'm2',
      text: '',
      content: [
        { type: 'text', text: 'Part one' },
        { type: 'tool_use', name: 'search' },
        { type: 'thinking', text: 'hidden' },
        { text: 'Part two' },
        { type: 'text', text: '' },
        { type: 'text' },
      ],
      sender: 'assistant',
      created_at: T2,
    },
  ],
};

describe('parseClaudeAiExport', () => {
  it('maps a conversation to a session row and messages', () => {
    const result = parseClaudeAiExport([CONVERSATION]);
    expect(result.errors).toStrictEqual([]);
    expect(result.conversations).toStrictEqual([
      {
        session: {
          id: 'chat-1',
          surface: 'claude-ai',
          title: 'Trip planning',
          cwd: null,
          updatedAt: Date.parse(T3),
          archived: false,
          handoffs: [],
        },
        createdAt: Date.parse(T1),
        summary: 'A summary',
        messages: [
          {
            id: 'm1',
            sender: 'human',
            text: 'Hello there',
            createdAt: Date.parse(T1),
            attachments: ['notes.txt', 'photo.png'],
          },
          {
            id: 'm2',
            sender: 'assistant',
            text: 'Part one\n\nPart two',
            createdAt: Date.parse(T2),
            attachments: [],
          },
        ],
      },
    ]);
  });

  it('accepts an object with a conversations array', () => {
    const result = parseClaudeAiExport({ conversations: [CONVERSATION] });
    expect(result.conversations.map((c) => c.session.id)).toStrictEqual(['chat-1']);
  });

  it('rejects anything that is not a list of conversations', () => {
    const expected = {
      conversations: [],
      errors: [
        { source: 'claude-ai-export', message: 'expected an array of conversations', path: null },
      ],
    };
    expect(parseClaudeAiExport({})).toStrictEqual(expected);
    expect(parseClaudeAiExport('x')).toStrictEqual(expected);
    expect(parseClaudeAiExport({ conversations: 'x' })).toStrictEqual(expected);
  });

  it('skips conversations without an id and reports only the index', () => {
    const result = parseClaudeAiExport([{ name: 'secret words' }, CONVERSATION, 5, { uuid: '' }]);
    expect(result.conversations).toHaveLength(1);
    expect(result.errors).toStrictEqual([
      { source: 'claude-ai-export', message: 'conversation 0 skipped', path: null },
      { source: 'claude-ai-export', message: 'conversation 2 skipped', path: null },
      { source: 'claude-ai-export', message: 'conversation 3 skipped', path: null },
    ]);
  });

  it('fills defaults for a bare conversation', () => {
    const [only] = parseClaudeAiExport([{ uuid: 'bare', name: ' '.repeat(3) }]).conversations;
    expect(only).toStrictEqual({
      session: {
        id: 'bare',
        surface: 'claude-ai',
        title: 'Untitled chat',
        cwd: null,
        updatedAt: 0,
        archived: false,
        handoffs: [],
      },
      createdAt: null,
      summary: null,
      messages: [],
    });
    expect(parseClaudeAiExport([{ uuid: 'n', name: null }]).conversations[0]?.session.title).toBe(
      'Untitled chat',
    );
  });

  it('falls back from updated_at to the newest message, then created_at', () => {
    const fromMessages = parseClaudeAiExport([
      {
        uuid: 'a',
        created_at: T1,
        updated_at: 'not a date',
        chat_messages: [
          { created_at: T2 },
          { created_at: T3 },
          { created_at: T1 },
          { created_at: 'bad' },
          {},
        ],
      },
    ]).conversations[0];
    expect(fromMessages?.session.updatedAt).toBe(Date.parse(T3));
    const fromCreated = parseClaudeAiExport([
      { uuid: 'b', created_at: T2, chat_messages: [{ created_at: 'bad' }] },
    ]).conversations[0];
    expect(fromCreated?.session.updatedAt).toBe(Date.parse(T2));
    expect(fromCreated?.createdAt).toBe(Date.parse(T2));
  });

  it('maps senders and tolerates odd messages', () => {
    const messages =
      parseClaudeAiExport([
        {
          uuid: 'c',
          chat_messages: [
            { sender: 'user', text: 'hi' },
            { sender: 'system' },
            { text: null, content: null },
            'junk',
            { sender: 'assistant', text: ' '.repeat(3), content: [{ type: 'text', text: 'real' }] },
          ],
        },
      ]).conversations[0]?.messages ?? [];
    expect(messages).toStrictEqual([
      { id: null, sender: 'human', text: 'hi', createdAt: null, attachments: [] },
      { id: null, sender: 'other', text: '', createdAt: null, attachments: [] },
      { id: null, sender: 'other', text: '', createdAt: null, attachments: [] },
      { id: null, sender: 'assistant', text: 'real', createdAt: null, attachments: [] },
    ]);
  });

  it('never throws on arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const result = parseClaudeAiExport(value);
        expect(Array.isArray(result.conversations)).toBe(true);
        for (const conversation of result.conversations) {
          expect(conversation.session.surface).toBe('claude-ai');
          expect(conversation.session.handoffs).toStrictEqual([]);
        }
      }),
    );
  });
});

describe('resolveExportFile', () => {
  it('returns a file path as is', async () => {
    const home = await makeScratchHome();
    const file = await home.writeJson('export/conversations.json', []);
    await expect(resolveExportFile(file)).resolves.toBe(file);
    await home.cleanup();
  });

  it('finds conversations.json in a folder or one wrapper folder down', async () => {
    const home = await makeScratchHome();
    const direct = await home.writeJson('a/conversations.json', []);
    await home.writeJson('a/users.json', []);
    await expect(resolveExportFile(path.join(home.root, 'a'))).resolves.toBe(direct);
    await home.makeDir('b/aaa-empty');
    await home.writeText('b/aaa.txt', 'not a folder');
    await home.makeDir('b/zzz/conversations.json');
    const nested = await home.writeJson('b/data-2026/conversations.json', []);
    await home.writeJson('b/zzz-later/conversations.json', []);
    await expect(resolveExportFile(path.join(home.root, 'b'))).resolves.toBe(nested);
    await home.cleanup();
  });

  it('ignores a folder named conversations.json at the top', async () => {
    const home = await makeScratchHome();
    await home.makeDir('c/conversations.json');
    const inner = await home.writeJson('c/conversations.json/conversations.json', []);
    await expect(resolveExportFile(path.join(home.root, 'c'))).resolves.toBe(inner);
    await home.cleanup();
  });

  it('fails clearly for a folder without the file and for a zip', async () => {
    const home = await makeScratchHome();
    await home.writeJson('d/sub/other.json', []);
    await expect(resolveExportFile(path.join(home.root, 'd'))).rejects.toThrow(
      new Error('no conversations.json in this folder'),
    );
    const zip = await home.writeText('export.ZIP', 'PK');
    await expect(resolveExportFile(zip)).rejects.toThrow(
      new Error('unzip the export first, then pick the folder or conversations.json'),
    );
    await home.cleanup();
  });
});

describe('importClaudeAiExport', () => {
  it('imports and stamps the time', async () => {
    const home = await makeScratchHome();
    const file = await home.writeJson('x/conversations.json', [CONVERSATION]);
    const result = await importClaudeAiExport(path.join(home.root, 'x'), { now: () => 42 });
    expect(result.importedAt).toBe(42);
    expect(result.sourcePath).toBe(file);
    expect(result.errors).toStrictEqual([]);
    expect(result.conversations).toStrictEqual(parseClaudeAiExport([CONVERSATION]).conversations);
    await home.cleanup();
  });

  it('uses the clock by default', async () => {
    const home = await makeScratchHome();
    const file = await home.writeJson('conversations.json', []);
    const before = Date.now();
    const result = await importClaudeAiExport(file);
    expect(result.importedAt).toBeGreaterThanOrEqual(before);
    expect(result.importedAt).toBeLessThanOrEqual(Date.now());
    await home.cleanup();
  });

  it('reports a missing path against the input', async () => {
    const home = await makeScratchHome();
    const missing = path.join(home.root, 'nope');
    const result = await importClaudeAiExport(missing, { now: () => 1 });
    expect(result.conversations).toStrictEqual([]);
    expect(result.sourcePath).toBeNull();
    expect(result.importedAt).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.source).toBe('claude-ai-export');
    expect(result.errors[0]?.path).toBe(missing);
    expect(result.errors[0]?.message).toMatch(/ENOENT/u);
    await home.cleanup();
  });

  it('reports bad JSON against the file it found', async () => {
    const home = await makeScratchHome();
    const file = await home.writeText('y/conversations.json', '[{');
    const result = await importClaudeAiExport(path.join(home.root, 'y'), { now: () => 1 });
    expect(result.sourcePath).toBe(file);
    expect(result.errors.map((error) => error.path)).toStrictEqual([file]);
    await home.cleanup();
  });
});
