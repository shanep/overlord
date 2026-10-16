import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findOnPath, isExecutableFile } from './find-on-path.js';

describe('findOnPath', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'overlord-path-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeProgram(dir: string, name: string, mode: number): string {
    mkdirSync(path.join(root, dir), { recursive: true });
    const file = path.join(root, dir, name);
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, mode);
    return file;
  }

  it('returns the first executable match in PATH order', () => {
    makeProgram('a', 'claude', 0o644);
    const wanted = makeProgram('b', 'claude', 0o755);
    makeProgram('c', 'claude', 0o755);
    const pathValue = ['', path.join(root, 'a'), path.join(root, 'b'), path.join(root, 'c')].join(
      ':',
    );
    expect(findOnPath({ name: 'claude', pathValue, platform: 'linux' })).toBe(wanted);
  });

  it('returns null when nothing matches or PATH is unset', () => {
    expect(findOnPath({ name: 'claude', pathValue: root, platform: 'darwin' })).toBeNull();
    expect(findOnPath({ name: 'claude', pathValue: undefined, platform: 'darwin' })).toBeNull();
  });

  it('passes names with a directory straight through', () => {
    expect(findOnPath({ name: '/opt/claude', pathValue: '', platform: 'linux' })).toBe(
      '/opt/claude',
    );
    expect(findOnPath({ name: String.raw`C:\bin\claude`, pathValue: '', platform: 'win32' })).toBe(
      String.raw`C:\bin\claude`,
    );
  });

  it('tries Windows suffixes with a semicolon separator', () => {
    const seen: string[] = [];
    const found = findOnPath({
      name: 'claude',
      pathValue: 'X;Y',
      platform: 'win32',
      isExecutable: (file) => {
        seen.push(file);
        return file === path.join('Y', 'claude.cmd');
      },
    });
    expect(found).toBe(path.join('Y', 'claude.cmd'));
    expect(seen).toStrictEqual([
      path.join('X', 'claude.exe'),
      path.join('X', 'claude.cmd'),
      path.join('X', 'claude'),
      path.join('Y', 'claude.exe'),
      path.join('Y', 'claude.cmd'),
    ]);
  });
});

describe('isExecutableFile', () => {
  it('is false for directories and missing files', () => {
    expect(isExecutableFile(os.tmpdir())).toBe(false);
    expect(isExecutableFile(path.join(os.tmpdir(), 'overlord-missing-file'))).toBe(false);
  });
});
