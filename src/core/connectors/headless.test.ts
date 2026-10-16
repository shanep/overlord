import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findHeadlessChrome, headlessConnector, playwrightDir } from './headless.js';

describe('playwrightDir', () => {
  it('follows the platform cache and the PLAYWRIGHT_BROWSERS_PATH override', () => {
    expect(playwrightDir({ home: '/h', platform: 'darwin', env: {} })).toBe(
      '/h/Library/Caches/ms-playwright',
    );
    expect(playwrightDir({ home: '/h', platform: 'linux', env: {} })).toBe(
      '/h/.cache/ms-playwright',
    );
    expect(
      playwrightDir({ home: '/h', platform: 'linux', env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' } }),
    ).toBe('/pw');
    // 0 means "inside node_modules", which is not a place we can look.
    expect(
      playwrightDir({ home: '/h', platform: 'linux', env: { PLAYWRIGHT_BROWSERS_PATH: '0' } }),
    ).toBe('/h/.cache/ms-playwright');
  });
});

/** An executable check that only passes the given files. */
function only(files: readonly string[]): (file: string) => boolean {
  return (file) => files.includes(file);
}

describe('findHeadlessChrome', () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ovl-headless-')));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function build(...parts: string[]): Promise<void> {
    await mkdir(path.join(home, '.cache', 'ms-playwright', ...parts), { recursive: true });
  }

  it('prefers the newest Playwright headless shell', async () => {
    await build('chromium_headless_shell-999', 'chrome-headless-shell-linux64');
    await build('chromium_headless_shell-1200', 'chrome-headless-shell-linux64');
    await build('chromium-1200', 'chrome-linux');
    const root = path.join(home, '.cache', 'ms-playwright');
    const newest = path.join(
      root,
      'chromium_headless_shell-1200',
      'chrome-headless-shell-linux64',
      'chrome-headless-shell',
    );
    const older = path.join(
      root,
      'chromium_headless_shell-999',
      'chrome-headless-shell-linux64',
      'chrome-headless-shell',
    );
    const chromium = path.join(root, 'chromium-1200', 'chrome-linux', 'chrome');
    const isExecutable = only([older, newest, chromium]);
    expect(await findHeadlessChrome({ home, platform: 'linux', env: {}, isExecutable })).toBe(
      newest,
    );
  });

  it('falls back to Playwright Chromium, then the Chrome app, then PATH', async () => {
    await build('chromium-1200', 'chrome-linux');
    const chromium = path.join(
      home,
      '.cache',
      'ms-playwright',
      'chromium-1200',
      'chrome-linux',
      'chrome',
    );
    expect(
      await findHeadlessChrome({
        home,
        platform: 'linux',
        env: {},
        isExecutable: only([chromium]),
      }),
    ).toBe(chromium);
    const app = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(
      await findHeadlessChrome({ home, platform: 'darwin', env: {}, isExecutable: only([app]) }),
    ).toBe(app);
    expect(
      await findHeadlessChrome({
        home,
        platform: 'linux',
        env: { PATH: '/usr/bin:/opt/bin' },
        isExecutable: only(['/opt/bin/chromium']),
      }),
    ).toBe('/opt/bin/chromium');
  });

  it('finds nothing on a bare machine', async () => {
    expect(
      await findHeadlessChrome({ home, platform: 'linux', env: {}, isExecutable: only([]) }),
    ).toBeNull();
    // The default check runs against the real disk, where this temp home has nothing.
    expect(await findHeadlessChrome({ home, platform: 'linux', env: { PATH: home } })).toBeNull();
  });
});

describe('headlessConnector', () => {
  it('is ready with the binary, or missing with how to add one', () => {
    expect(headlessConnector('/bin/chrome')).toStrictEqual({
      id: 'headless:chrome',
      name: 'Headless Chrome',
      kind: 'headless',
      fix: null,
      target: '/bin/chrome',
      status: 'ok',
      detail: 'Installed and ready to run headless.',
    });
    expect(headlessConnector(null)).toStrictEqual({
      id: 'headless:chrome',
      name: 'Headless Chrome',
      kind: 'headless',
      fix: null,
      target: '',
      status: 'missing',
      detail:
        'No Chrome or Chromium that can run headless was found. Run `npx playwright install chromium-headless-shell` to add one.',
    });
  });
});
