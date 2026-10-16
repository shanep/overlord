import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addOverlordHooks,
  DEFAULT_HOOK_EVENTS,
  EVENT_TIMEOUT_S,
  HOOK_MARKER,
  hookTimeoutFor,
  installedEvents,
  installHooks,
  isInstalled,
  overlordEvents,
  PERMISSION_TIMEOUT_S,
  removeOverlordHooks,
  resolveTarget,
  uninstallHooks,
} from './install.js';

async function json(target: string): Promise<unknown> {
  return JSON.parse(await readFile(target, 'utf8'));
}

async function modeOf(target: string): Promise<number> {
  const info = await stat(target);
  return info.mode & 0o777;
}

async function sortedEntries(target: string): Promise<string[]> {
  const names = await readdir(target);
  return names.toSorted((left, right) => left.localeCompare(right));
}

async function isLink(target: string): Promise<boolean> {
  const info = await lstat(target);
  return info.isSymbolicLink();
}

const COMMAND = 'node "/ext/dist/overlord-hook.cjs"';

const userHook = { type: 'command', command: '~/bin/lint.sh', timeout: 30 };

describe('hook settings transforms', () => {
  it('uses long timeouts only for PermissionRequest', () => {
    expect(PERMISSION_TIMEOUT_S).toBe(600);
    expect(EVENT_TIMEOUT_S).toBe(5);
    expect(hookTimeoutFor('PermissionRequest')).toBe(600);
    expect(hookTimeoutFor('PreToolUse')).toBe(5);
    expect(HOOK_MARKER).toBe('overlord-hook');
  });

  it('installs the documented shape for every default event', () => {
    expect(DEFAULT_HOOK_EVENTS).toHaveLength(15);
    const settings = addOverlordHooks({}, COMMAND, DEFAULT_HOOK_EVENTS);
    expect(Object.keys(settings)).toStrictEqual(['hooks']);
    const hooks = settings['hooks'];
    expect(Object.keys(hooks ?? {})).toStrictEqual([...DEFAULT_HOOK_EVENTS]);
    expect(settings).toMatchObject({
      hooks: {
        PermissionRequest: [{ hooks: [{ type: 'command', command: COMMAND, timeout: 600 }] }],
        Stop: [{ hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }],
      },
    });
  });

  it('appends after user hooks and keeps other keys in place', () => {
    const settings = {
      model: 'opus',
      hooks: { Stop: [{ matcher: '', hooks: [userHook] }] },
      env: { A: '1' },
    };
    const next = addOverlordHooks(settings, COMMAND, ['Stop', 'Stop', 'SessionEnd']);
    expect(Object.keys(next)).toStrictEqual(['model', 'hooks', 'env']);
    expect(next).toStrictEqual({
      model: 'opus',
      hooks: {
        Stop: [
          { matcher: '', hooks: [userHook] },
          { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] },
        ],
        SessionEnd: [{ hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }],
      },
      env: { A: '1' },
    });
  });

  it('replaces an older Overlord command instead of adding a second', () => {
    const old = addOverlordHooks({}, 'node /old/overlord-hook.cjs', ['Stop']);
    const next = addOverlordHooks(old, COMMAND, ['Stop']);
    expect(next).toStrictEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }] },
    });
  });

  it('refuses a command it could not find again', () => {
    expect(() => addOverlordHooks({}, 'node /x/hook.cjs', ['Stop'])).toThrow(
      'the hook command must contain "overlord-hook"',
    );
  });

  it('removes only Overlord handlers and drops what is left empty', () => {
    const settings = {
      hooks: {
        Stop: [
          { matcher: '', hooks: [userHook, { type: 'command', command: COMMAND }] },
          { hooks: [{ type: 'command', command: COMMAND }] },
        ],
        SessionEnd: [{ hooks: [{ type: 'command', command: COMMAND }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [userHook] }],
        Notification: [{ hooks: [{ type: 'http', url: 'https://x/overlord-hook' }] }],
      },
      other: true,
    };
    expect(removeOverlordHooks(settings)).toStrictEqual({
      hooks: {
        Stop: [{ matcher: '', hooks: [userHook] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [userHook] }],
        Notification: [{ hooks: [{ type: 'http', url: 'https://x/overlord-hook' }] }],
      },
      other: true,
    });
  });

  it('drops the hooks block when only Overlord was in it', () => {
    const settings = { a: 1, ...addOverlordHooks({}, COMMAND, ['Stop']), b: 2 };
    const next = removeOverlordHooks(settings);
    expect(next).toStrictEqual({ a: 1, b: 2 });
    expect(Object.keys(next)).toStrictEqual(['a', 'b']);
  });

  it('leaves settings without Overlord hooks untouched', () => {
    const settings = { hooks: {}, a: 1 };
    expect(removeOverlordHooks(settings)).toBe(settings);
    const plain = { a: 1 };
    expect(removeOverlordHooks(plain)).toBe(plain);
  });

  it('lists the events with an Overlord hook', () => {
    const settings = addOverlordHooks(
      { hooks: { PreToolUse: [{ hooks: [userHook] }], Stop: [{ hooks: [{ type: 'command' }] }] } },
      COMMAND,
      ['SessionStart'],
    );
    expect(overlordEvents(settings)).toStrictEqual(['SessionStart']);
    expect(overlordEvents({})).toStrictEqual([]);
  });

  it('refuses a hooks block it does not understand', () => {
    expect(() => removeOverlordHooks({ hooks: [] })).toThrow(
      'the settings file has a "hooks" block in a shape Overlord does not recognize',
    );
    expect(() => overlordEvents({ hooks: { Stop: [{ hooks: 'x' }] } })).toThrow(
      'does not recognize',
    );
  });
});

describe('installHooks and uninstallHooks', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-install-'));
    file = path.join(dir, 'settings.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a missing settings file with 2-space JSON and no backup', async () => {
    expect(
      await installHooks({ settingsFile: file, hookCommand: COMMAND, events: ['Stop'] }),
    ).toStrictEqual({
      changed: true,
    });
    expect(await readFile(file, 'utf8')).toBe(
      `{\n  "hooks": {\n    "Stop": [\n      {\n        "hooks": [\n          {\n            "type": "command",\n            "command": ${JSON.stringify(COMMAND)},\n            "timeout": 5\n          }\n        ]\n      }\n    ]\n  }\n}\n`,
    );
    expect(await readdir(dir)).toStrictEqual(['settings.json']);
    expect(await modeOf(file)).toBe(0o600);
  });

  it('installs every default event when none are given', async () => {
    await installHooks({ settingsFile: file, hookCommand: COMMAND });
    expect(await installedEvents({ settingsFile: file })).toStrictEqual([...DEFAULT_HOOK_EVENTS]);
  });

  it('is idempotent', async () => {
    await writeFile(file, '{"model":"opus"}');
    await installHooks({ settingsFile: file, hookCommand: COMMAND });
    const first = await readFile(file, 'utf8');
    expect(await installHooks({ settingsFile: file, hookCommand: COMMAND })).toStrictEqual({
      changed: false,
    });
    expect(await readFile(file, 'utf8')).toBe(first);
    expect(await readFile(`${file}.bak`, 'utf8')).toBe('{"model":"opus"}');
  });

  it('keeps a backup of the previous file and its mode', async () => {
    await writeFile(file, '{\n  "env": {"A": "1"}\n}\n');
    await chmod(file, 0o644);
    await installHooks({ settingsFile: file, hookCommand: COMMAND, events: ['Stop'] });
    expect(await readFile(`${file}.bak`, 'utf8')).toBe('{\n  "env": {"A": "1"}\n}\n');
    expect(await modeOf(file)).toBe(0o644);
    expect(await json(file)).toStrictEqual({
      env: { A: '1' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] }] },
    });
    expect(await sortedEntries(dir)).toStrictEqual(['settings.json', 'settings.json.bak']);
  });

  it('writes through a symlink and keeps the link', async () => {
    const real = path.join(dir, 'dotfiles', 'settings.json');
    await mkdir(path.dirname(real));
    await writeFile(real, '{"a":1}');
    await symlink(real, file);
    await installHooks({ settingsFile: file, hookCommand: COMMAND, events: ['Stop'] });
    expect(await isLink(file)).toBe(true);
    expect(await json(real)).toMatchObject({ a: 1, hooks: { Stop: [{}] } });
    expect(await readFile(`${real}.bak`, 'utf8')).toBe('{"a":1}');
    expect(await isInstalled({ settingsFile: file })).toBe(true);
    await uninstallHooks({ settingsFile: file });
    expect(await isLink(file)).toBe(true);
    expect(await json(real)).toStrictEqual({ a: 1 });
  });

  it('follows a dangling symlink to create its target', async () => {
    const real = path.join(dir, 'target.json');
    await symlink('target.json', file);
    await installHooks({ settingsFile: file, hookCommand: COMMAND, events: ['Stop'] });
    expect(await isLink(file)).toBe(true);
    expect(await json(real)).toMatchObject({ hooks: { Stop: [{}] } });
  });

  it('resolves targets', async () => {
    expect(await resolveTarget(path.join(dir, 'none.json'))).toBe(path.join(dir, 'none.json'));
    await symlink('/nowhere/x.json', file);
    expect(await resolveTarget(file)).toBe('/nowhere/x.json');
  });

  it('uninstalls only Overlord entries', async () => {
    await writeFile(
      file,
      JSON.stringify({ hooks: { Stop: [{ hooks: [userHook] }] }, theme: 'dark' }),
    );
    await installHooks({
      settingsFile: file,
      hookCommand: COMMAND,
      events: ['Stop', 'SessionEnd'],
    });
    expect(await installedEvents({ settingsFile: file })).toStrictEqual(['Stop', 'SessionEnd']);
    expect(await uninstallHooks({ settingsFile: file })).toStrictEqual({ changed: true });
    expect(await json(file)).toStrictEqual({
      hooks: { Stop: [{ hooks: [userHook] }] },
      theme: 'dark',
    });
    expect(await isInstalled({ settingsFile: file })).toBe(false);
    expect(await uninstallHooks({ settingsFile: file })).toStrictEqual({ changed: false });
  });

  it('does not create a file on uninstall', async () => {
    expect(await uninstallHooks({ settingsFile: file })).toStrictEqual({ changed: false });
    expect(await readdir(dir)).toStrictEqual([]);
    expect(await isInstalled({ settingsFile: file })).toBe(false);
    expect(
      await installHooks({ settingsFile: file, hookCommand: COMMAND, events: [] }),
    ).toStrictEqual({
      changed: false,
    });
    expect(await readdir(dir)).toStrictEqual([]);
  });

  it('treats an empty file as empty settings', async () => {
    await writeFile(file, '  \n');
    await installHooks({ settingsFile: file, hookCommand: COMMAND, events: ['Stop'] });
    expect(await installedEvents({ settingsFile: file })).toStrictEqual(['Stop']);
    expect(await readFile(`${file}.bak`, 'utf8')).toBe('  \n');
  });

  it('refuses files it cannot parse and leaves them alone', async () => {
    await writeFile(file, '{ not json');
    await expect(installHooks({ settingsFile: file, hookCommand: COMMAND })).rejects.toThrow(
      SyntaxError,
    );
    await writeFile(file, '[1, 2]');
    await expect(installHooks({ settingsFile: file, hookCommand: COMMAND })).rejects.toThrow(
      `${file} does not hold a JSON object`,
    );
    expect(await readFile(file, 'utf8')).toBe('[1, 2]');
    expect(await readdir(dir)).toStrictEqual(['settings.json']);
  });

  it('refuses a settings path that is not a file', async () => {
    await mkdir(file);
    await expect(installHooks({ settingsFile: file, hookCommand: COMMAND })).rejects.toThrow();
    expect(await readdir(file)).toStrictEqual([]);
  });

  it('cleans up the temp file when the write fails', async () => {
    await writeFile(file, '{}');
    await mkdir(`${file}.bak`);
    await writeFile(path.join(`${file}.bak`, 'keep'), 'x');
    await expect(installHooks({ settingsFile: file, hookCommand: COMMAND })).rejects.toThrow();
    expect(await sortedEntries(dir)).toStrictEqual(['settings.json', 'settings.json.bak']);
    expect(await readFile(file, 'utf8')).toBe('{}');
  });
});
