// Reload the window when a new build of Overlord is installed over this one,
// and record which build this window loaded. Only installed copies do this: a
// development host would reload on every `npm run build`.

import { statSync, unwatchFile, watchFile } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

import type { ClaudePaths } from '../core/paths.js';
import type { WatchFile } from '../core/self-update.js';
import { loadedMarkerPath, watchForUpdate, writeLoadedMarker } from '../core/self-update.js';

const POLL_MS = 1000;
const SETTLE_MS = 2000;

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
  const stop = watchForUpdate({
    bundle,
    watch: pollFile,
    settleMs: SETTLE_MS,
    onUpdate: () => {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
  });
  return { dispose: stop };
}
