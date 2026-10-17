import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveClaudePaths } from '../paths.js';
import { transcriptPathFor } from '../surfaces/desktop.js';

import { lastModel, ranOnBridge } from './session-backend.js';

const reply = (model: string): string =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [] } });

describe('lastModel', () => {
  it('finds the last real reply, skipping cut lines, notes and other entries', () => {
    const text = [
      '"message":{"role":"assistant","model":"claude-opus',
      reply('claude-opus-5-5'),
      reply('global.anthropic.claude-opus-5-5'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      reply('<synthetic>'),
      '{"type":"assistant","message":null}',
      '{"type":"assistant","message":{"model":7}}',
      '"assistant"',
      '',
    ].join('\n');
    expect(lastModel(text)).toBe('global.anthropic.claude-opus-5-5');
    expect(lastModel(reply('<synthetic>'))).toBeNull();
    expect(lastModel('')).toBeNull();
  });
});

describe('ranOnBridge', () => {
  it('says whether the transcript last replied through the bridge', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'overlord-backend-'));
    const paths = resolveClaudePaths({ home: dir, platform: process.platform, env: {} });
    const write = async (id: string, text: string): Promise<void> => {
      const file = transcriptPathFor(paths, '/work/app', id);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    };
    await write('bridge', `${reply('global.anthropic.claude-opus-5-5')}\n`);
    await write('usual', `${reply('claude-opus-5-5')}\n`);
    expect(await ranOnBridge(paths, '/work/app', 'bridge')).toBe(true);
    expect(await ranOnBridge(paths, '/work/app', 'usual')).toBe(false);
    expect(await ranOnBridge(paths, '/work/app', 'missing')).toBe(false);
  });
});
