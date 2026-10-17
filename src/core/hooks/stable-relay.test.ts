import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installStableRelay, stableHookCommand, stableRelayPath } from './stable-relay.js';

describe('installStableRelay', () => {
  let dir: string;
  let home: string;
  let extension: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-relay-'));
    home = path.join(dir, 'home');
    extension = path.join(dir, 'ext-1.0.0');
    await mkdir(path.join(extension, 'dist'), { recursive: true });
    await writeFile(path.join(extension, 'dist', 'overlord-hook.cjs'), 'relay v1');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('copies the relay to one path for every version and names it in a fixed command', async () => {
    const command = await installStableRelay(extension, home);
    expect(command).toBe(stableHookCommand(home));
    expect(command).toBe(`node "${path.join(home, '.overlord', 'bin', 'overlord-hook.cjs')}"`);
    expect(command).toContain('overlord-hook');
    expect(await readFile(stableRelayPath(home), 'utf8')).toBe('relay v1');
    const before = await stat(stableRelayPath(home));
    await installStableRelay(extension, home);
    const after = await stat(stableRelayPath(home));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const next = path.join(dir, 'ext-1.1.0');
    await mkdir(path.join(next, 'dist'), { recursive: true });
    await writeFile(path.join(next, 'dist', 'overlord-hook.cjs'), 'relay v2');
    expect(await installStableRelay(next, home)).toBe(command);
    expect(await readFile(stableRelayPath(home), 'utf8')).toBe('relay v2');
  });

  it('throws when the extension has no relay', async () => {
    await expect(installStableRelay(path.join(dir, 'none'), home)).rejects.toThrow();
  });
});
