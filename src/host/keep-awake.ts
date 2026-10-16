// Block system sleep while this window has Overlord loaded, following the
// overlord.keepAwake setting.

import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

import type { KeepAwakeSpawn } from '../core/keep-awake.js';
import { KeepAwake, keepAwakeLaunch } from '../core/keep-awake.js';

const spawnHelper: KeepAwakeSpawn = (launch, onExit) => {
  const child = spawn(launch.command, [...launch.args], { stdio: 'ignore' });
  // A failed start emits error and may never emit exit, so listen for both.
  child.once('error', onExit);
  child.once('exit', onExit);
  return {
    kill: (): void => {
      child.kill();
    },
  };
};

function enabled(): boolean {
  return vscode.workspace.getConfiguration('overlord').get<boolean>('keepAwake', true);
}

export function keepAwake(): vscode.Disposable {
  const awake = new KeepAwake(
    keepAwakeLaunch({ platform: process.platform, pid: process.pid }),
    spawnHelper,
  );
  awake.setEnabled(enabled());
  const watcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('overlord.keepAwake')) {
      awake.setEnabled(enabled());
    }
  });
  return {
    dispose: (): void => {
      watcher.dispose();
      awake.dispose();
    },
  };
}
