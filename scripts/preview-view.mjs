// Screenshots one webview view with sample data, in a light and a dark theme
// and at a wide and a narrow width, so a layout change can be looked at before
// it is committed. It builds the webview, serves it with a stand-in for the
// VS Code API that hands the view its state, and runs headless Chrome.
//
//   node scripts/preview-view.mjs connectors
//   node scripts/preview-view.mjs connectors --click "Install…" --state my-state.json
//   node scripts/preview-view.mjs fleet --state webview/preview/fleet-agents.json --agents webview/preview/agents-list.json
//
// The state comes from webview/preview/<view>.json unless --state names
// another file. It is the view's state as src/shared/protocol.ts types it.
// --agents names a JSON file with the AgentInfo list every host message
// carries. Without it the list is empty, which the views read as Claude Code
// alone.
// Each --click presses the first button with that text, in order, so a
// screenshot can show an open form or a menu. --narrow sets the narrow width,
// such as 320 for a view that lives in the sidebar, and --layout sidebar lays
// the view out the way the sidebar does.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function shots(narrow) {
  return [
    { name: 'light-wide', theme: 'light', width: 1200 },
    { name: 'dark-wide', theme: 'dark', width: 1200 },
    { name: 'dark-narrow', theme: 'dark', width: narrow },
  ];
}

// The VS Code theme variables theme.css reads, from the Light Modern and Dark Modern themes.
const THEMES = {
  light: {
    foreground: '#3b3b3b',
    descriptionForeground: '#717171',
    'editor-background': '#ffffff',
    'sideBar-background': '#f8f8f8',
    'editorWidget-background': '#f8f8f8',
    'panel-border': '#e5e5e5',
    focusBorder: '#005fb8',
    'textLink-foreground': '#005fb8',
    'button-background': '#005fb8',
    'button-foreground': '#ffffff',
    'button-hoverBackground': '#0258a8',
    'button-secondaryBackground': '#e5e5e5',
    'button-secondaryForeground': '#3b3b3b',
    'input-background': '#ffffff',
    'input-foreground': '#3b3b3b',
    'input-border': '#cecece',
    'badge-background': '#cccccc',
    'badge-foreground': '#3b3b3b',
    'textCodeBlock-background': '#f2f2f2',
  },
  dark: {
    foreground: '#cccccc',
    descriptionForeground: '#9d9d9d',
    'editor-background': '#1f1f1f',
    'sideBar-background': '#181818',
    'editorWidget-background': '#202020',
    'panel-border': '#2b2b2b',
    focusBorder: '#0078d4',
    'textLink-foreground': '#4daafc',
    'button-background': '#0078d4',
    'button-foreground': '#ffffff',
    'button-hoverBackground': '#026ec1',
    'button-secondaryBackground': '#313131',
    'button-secondaryForeground': '#cccccc',
    'input-background': '#313131',
    'input-foreground': '#cccccc',
    'input-border': '#3c3c3c',
    'badge-background': '#616161',
    'badge-foreground': '#f8f8f8',
    'textCodeBlock-background': '#2b2b2b',
  },
};

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.map': 'application/json',
};

class UsageError extends Error {}

function themeCss() {
  return Object.entries(THEMES)
    .map(([name, colors]) => {
      const lines = Object.entries(colors).map(([key, value]) => `--vscode-${key}: ${value};`);
      return `html.${name} { ${lines.join(' ')} }`;
    })
    .join('\n');
}

function page(view, clicks, agents, layout) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Overlord preview: ${view}</title>
<style>body { font-family: -apple-system, system-ui, sans-serif; font-size: 13px; }
${themeCss()}</style>
<script>
const params = new URLSearchParams(location.search);
document.documentElement.classList.add(params.get('theme') ?? 'light');
// Headless Chrome will not make a window narrower than about 500 px, so the page holds itself to the width asked for.
document.documentElement.style.maxWidth = (params.get('width') ?? '') + 'px';
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: async (message) => {
    if (message.type !== 'ready') return;
    const state = await (await fetch('./state.json')).json();
    window.postMessage({ type: 'state', view: ${JSON.stringify(view)}, state, agents: ${agents} }, '*');
  },
});
const clicks = ${JSON.stringify(clicks)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  await wait(800);
  for (const text of clicks) {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    if (button === undefined) console.error('No button says ' + text);
    button?.click();
    await wait(300);
  }
})();
</script>
<script type="module" src="./main.js"></script>
</head>
<body><div id="root" data-view="${view}" data-layout="${layout}"></div></body>
</html>
`;
}

function run(command, args, quiet = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: quiet ? 'ignore' : 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(command)} exited ${String(code)}`));
      }
    });
  });
}

/** Chrome or Chromium: CHROME_PATH, then the usual places on macOS and Linux. */
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter((candidate) => candidate !== undefined && candidate !== '');
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found !== undefined) {
    return found;
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const which = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim() !== '') {
      return which.stdout.trim();
    }
  }
  throw new UsageError('Could not find Chrome. Set CHROME_PATH to a Chrome or Chromium binary.');
}

function serve(dir) {
  const server = createServer((request, response) => {
    const name = path.basename(new URL(request.url ?? '/', 'file:///').pathname) || 'index.html';
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'text/plain' });
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      state: { type: 'string' },
      agents: { type: 'string' },
      click: { type: 'string', multiple: true, default: [] },
      out: { type: 'string', default: path.join(root, '.cache', 'preview') },
      height: { type: 'string', default: '1600' },
      narrow: { type: 'string', default: '700' },
      layout: { type: 'string', default: 'panel' },
    },
  });
  const [view] = positionals;
  if (view === undefined) {
    throw new UsageError(
      'Usage: node scripts/preview-view.mjs <view> [--state file.json] [--click "Button text"]',
    );
  }
  const stateFile = values.state ?? path.join(root, 'webview', 'preview', `${view}.json`);
  if (!existsSync(stateFile)) {
    throw new UsageError(
      `No sample state at ${stateFile}. Write one with the view's state, or pass --state.`,
    );
  }

  const chrome = findChrome();
  const work = mkdtempSync(path.join(os.tmpdir(), `overlord-preview-${view}-`));
  try {
    const site = path.join(work, 'site');
    await run(process.execPath, [
      path.join(root, 'scripts', 'slot.mjs'),
      path.join(root, 'node_modules', '.bin', 'vite'),
      'build',
      '--config',
      'webview/vite.config.ts',
      '--mode',
      'development',
      '--outDir',
      site,
      '--emptyOutDir',
      '--logLevel',
      'warn',
    ]);
    const agents = values.agents === undefined ? '[]' : readFileSync(values.agents, 'utf8').trim();
    writeFileSync(path.join(site, 'index.html'), page(view, values.click, agents, values.layout));
    writeFileSync(path.join(site, 'state.json'), readFileSync(stateFile));
    mkdirSync(values.out, { recursive: true });
    const server = await serve(site);
    const { port } = server.address();
    try {
      for (const shot of shots(Number.parseInt(values.narrow, 10))) {
        const file = path.join(values.out, `${view}-${shot.name}.png`);
        await run(
          chrome,
          [
            '--headless=new',
            '--disable-gpu',
            '--hide-scrollbars',
            `--user-data-dir=${path.join(work, 'profile')}`,
            '--virtual-time-budget=5000',
            `--window-size=${String(shot.width)},${values.height}`,
            `--screenshot=${file}`,
            `http://127.0.0.1:${String(port)}/index.html?theme=${shot.theme}&width=${String(shot.width)}`,
          ],
          true,
        );
        process.stdout.write(`${file}\n`);
      }
    } finally {
      server.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
