// A Chrome that can run headless, for the screenshot and page rendering work
// agents do without a window: Playwright's chrome-headless-shell or Chromium
// first, then an installed Chrome or Chromium.

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Connector } from '../../shared/connectors.js';
import { findOnPath, isExecutableFile } from '../find-on-path.js';

const HEADLESS_NAME = 'Headless Chrome';

/** Executables inside a Playwright browser folder, by the folder's name prefix. */
const PLAYWRIGHT_BUILDS: readonly { readonly prefix: string; readonly files: readonly string[] }[] =
  [
    { prefix: 'chromium_headless_shell-', files: ['chrome-headless-shell'] },
    {
      prefix: 'chromium-',
      files: [
        'Chromium.app/Contents/MacOS/Chromium',
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome',
      ],
    },
  ];

const APP_BINARIES: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
};

const PATH_NAMES: readonly string[] = [
  'chrome-headless-shell',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
];

export interface HeadlessInput {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isExecutable?: (file: string) => boolean;
}

/** Where Playwright keeps its browsers. */
export function playwrightDir(input: HeadlessInput): string {
  const override = input.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '';
  if (override !== '' && override !== '0') {
    return override;
  }
  return input.platform === 'darwin'
    ? path.join(input.home, 'Library', 'Caches', 'ms-playwright')
    : path.join(input.home, '.cache', 'ms-playwright');
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Newest build first, so the version number decides and not the name order. */
function byNewest(left: string, right: string): number {
  return right.localeCompare(left, 'en', { numeric: true });
}

async function playwrightBinary(
  input: HeadlessInput,
  check: (file: string) => boolean,
): Promise<string | null> {
  const root = playwrightDir(input);
  const listed = await names(root);
  const builds = listed.toSorted(byNewest);
  for (const { prefix, files } of PLAYWRIGHT_BUILDS) {
    for (const build of builds.filter((name) => name.startsWith(prefix))) {
      // Inside each build is one folder per platform, such as chrome-headless-shell-mac-arm64.
      for (const inner of await names(path.join(root, build))) {
        const found = files
          .map((file) => path.join(root, build, inner, file))
          .find((file) => check(file));
        if (found !== undefined) {
          return found;
        }
      }
    }
  }
  return null;
}

/** The first headless capable Chrome, or null. */
export async function findHeadlessChrome(input: HeadlessInput): Promise<string | null> {
  const check = input.isExecutable ?? isExecutableFile;
  const playwright = await playwrightBinary(input, check);
  if (playwright !== null) {
    return playwright;
  }
  const app = (APP_BINARIES[input.platform] ?? []).find((file) => check(file));
  if (app !== undefined) {
    return app;
  }
  for (const name of PATH_NAMES) {
    const found = findOnPath({
      name,
      pathValue: input.env['PATH'],
      platform: input.platform,
      isExecutable: check,
    });
    if (found !== null) {
      return found;
    }
  }
  return null;
}

export function headlessConnector(binary: string | null): Connector {
  const base = { id: 'headless:chrome', name: HEADLESS_NAME, kind: 'headless', fix: null } as const;
  return binary === null
    ? {
        ...base,
        target: '',
        status: 'missing',
        detail:
          'No Chrome or Chromium that can run headless was found. Run `npx playwright install chromium-headless-shell` to add one.',
      }
    : { ...base, target: binary, status: 'ok', detail: 'Installed and ready to run headless.' };
}
