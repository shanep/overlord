import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AuditEntry } from './audit.js';
import { AuditLog } from './audit.js';

async function modeOf(target: string): Promise<number> {
  const info = await stat(target);
  return info.mode & 0o777;
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    at: 1000,
    requestId: 'req-1',
    sessionId: 's1',
    agentId: 's1',
    toolName: 'Bash',
    ruleId: 'rule-1',
    behavior: 'allow',
    ...overrides,
  };
}

describe('AuditLog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-audit-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends JSON lines in order and creates private files', async () => {
    const file = path.join(dir, 'nested', 'audit.jsonl');
    const log = new AuditLog(file);
    expect(log.filePath).toBe(file);
    await Promise.all([
      log.append(entry({ requestId: 'a' })),
      log.append(entry({ requestId: 'b', behavior: 'deny' })),
      log.append(entry({ requestId: 'c' })),
    ]);
    const text = await readFile(file, 'utf8');
    expect(text.split('\n')).toHaveLength(4);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text.split('\n', 1)[0] ?? '')).toStrictEqual(entry({ requestId: 'a' }));
    const entries = await log.read();
    expect(entries.map((item) => item.requestId)).toStrictEqual(['a', 'b', 'c']);
    expect(entries[1]?.behavior).toBe('deny');
    expect(await modeOf(file)).toBe(0o600);
    expect(await modeOf(path.dirname(file))).toBe(0o700);
  });

  it('only writes known fields', async () => {
    const file = path.join(dir, 'audit.jsonl');
    const log = new AuditLog(file);
    const withExtra = { ...entry(), extra: 'x' };
    await log.append(withExtra);
    expect(await readFile(file, 'utf8')).not.toContain('extra');
  });

  it('reads a missing file as empty', async () => {
    expect(await new AuditLog(path.join(dir, 'none.jsonl')).read()).toStrictEqual([]);
  });

  it('skips lines that are not valid entries', async () => {
    const file = path.join(dir, 'audit.jsonl');
    await writeFile(
      file,
      `${JSON.stringify(entry({ requestId: 'ok' }))}\nnot json\n\n{"at":"x"}\n   \n${JSON.stringify(entry({ requestId: 'ok2' }))}\n`,
    );
    const entries = await new AuditLog(file).read();
    expect(entries.map((item) => item.requestId)).toStrictEqual(['ok', 'ok2']);
  });

  it('rejects an invalid entry without writing', async () => {
    const file = path.join(dir, 'audit.jsonl');
    const log = new AuditLog(file);
    const bad = entry();
    Reflect.set(bad, 'behavior', 'maybe');
    await expect(log.append(bad)).rejects.toThrow();
    expect(await log.read()).toStrictEqual([]);
  });

  it('keeps appending after a failed write', async () => {
    const file = path.join(dir, 'audit.jsonl');
    await mkdir(file);
    const log = new AuditLog(file);
    await expect(log.append(entry())).rejects.toThrow();
    await rm(file, { recursive: true });
    await log.append(entry({ requestId: 'after' }));
    const entries = await log.read();
    expect(entries.map((item) => item.requestId)).toStrictEqual(['after']);
  });
});
