// Reload the window when a new build of Overlord is installed over this one,
// and record which build this window loaded. Only installed copies do this: a
// development host would reload on every `npm run build`. A reload ends every
// Launcher run, so a new build waits for them to finish.

import { readFileSync, statSync, unwatchFile, watchFile } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

import { isPlainObject } from '../core/knobs/json.js';
import type { ClaudePaths } from '../core/paths.js';
import type { SelfCheckReport } from '../core/self-check.js';
import { selfCheckPath, writeSelfCheck } from '../core/self-check.js';
import type { ReloadBlockers, WatchFile } from '../core/self-update.js';
import {
  heldMarkerPath,
  loadedMarkerPath,
  watchForUpdate,
  writeHeldMarker,
  writeLoadedMarker,
} from '../core/self-update.js';

const POLL_MS = 1000;
const SETTLE_MS = 2000;
/** Lets activation finish before the self-check starts building views. */
const CHECK_DELAY_MS = 3000;

const pollFile: WatchFile = (file, listener) => {
  const onPoll = (current: { readonly mtimeMs: number }): void => {
    listener(current.mtimeMs);
  };
  watchFile(file, { interval: POLL_MS, persistent: false }, onPoll);
  return () => {
    unwatchFile(file, onPoll);
  };
};

function ignore(): void {
  // Deliberately empty, see the call site.
}

export function reloadOnUpdate(
  context: vscode.ExtensionContext,
  paths: ClaudePaths,
  runs: ReloadBlockers,
): vscode.Disposable {
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    return new vscode.Disposable(() => {
      // Nothing to stop in a development host.
    });
  }
  const bundle = path.join(context.extensionUri.fsPath, 'dist', 'extension.cjs');
  const marker = {
    bundleMtimeMs: statSync(bundle, { throwIfNoEntry: false })?.mtimeMs ?? 0,
    pid: process.pid,
    at: Date.now(),
  };
  // The marker only helps the install script report success, so a failed
  // write must not stop the extension from starting.
  writeLoadedMarker(loadedMarkerPath(paths), marker).catch(ignore);
  let notice: vscode.Disposable | undefined;
  const stop = watchForUpdate({
    bundle,
    watch: pollFile,
    settleMs: SETTLE_MS,
    runs,
    onHold: (count) => {
      const held = {
        bundleMtimeMs: statSync(bundle, { throwIfNoEntry: false })?.mtimeMs ?? 0,
        runs: count,
        pid: process.pid,
        at: Date.now(),
      };
      // Like the loaded marker, this only feeds the install script's message.
      writeHeldMarker(heldMarkerPath(paths), held).catch(ignore);
      notice = vscode.window.setStatusBarMessage(
        `$(sync) Overlord update waits for ${count.toString()} Launcher ${count === 1 ? 'run' : 'runs'} to finish`,
      );
    },
    onUpdate: () => {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
  });
  return {
    dispose: (): void => {
      stop();
      notice?.dispose();
    },
  };
}

/** The bundle mtime the last self-check ran on, or null when there is none. */
function checkedBundle(file: string): number | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const mtime = isPlainObject(saved) ? saved['bundleMtimeMs'] : null;
    return typeof mtime === 'number' ? mtime : null;
  } catch {
    return null;
  }
}

/**
 * Runs the self-check once, a moment after an installed build loads, and
 * writes the result for the install script. A development host skips it.
 */
export function selfCheckOnLoad(
  context: vscode.ExtensionContext,
  paths: ClaudePaths,
  run: () => Promise<Omit<SelfCheckReport, 'bundleMtimeMs'>>,
): vscode.Disposable {
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    return new vscode.Disposable(() => {
      // Nothing to stop in a development host.
    });
  }
  const bundle = path.join(context.extensionUri.fsPath, 'dist', 'extension.cjs');
  const bundleMtimeMs = statSync(bundle, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const file = selfCheckPath(paths);
  // Only the first load of a new build checks itself. Later windows and reloads skip it.
  if (checkedBundle(file) === bundleMtimeMs) {
    return new vscode.Disposable(() => {
      // Nothing was started.
    });
  }
  const timer = setTimeout(() => {
    // Like the markers, the check only feeds the install script, so a failure stays quiet.
    run()
      .then(async (report) => writeSelfCheck(file, { ...report, bundleMtimeMs }))
      .catch(ignore);
  }, CHECK_DELAY_MS);
  return new vscode.Disposable(() => {
    clearTimeout(timer);
  });
}
