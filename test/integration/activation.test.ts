// Runs inside a real VS Code instance through @vscode/test-cli.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'shanep.overlord';

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Runs a command that asks with a quick pick and takes the first item, the
 * way Enter would, since nobody is here to answer it. Accepting before the
 * pick opens does nothing, so it keeps trying until the command finishes.
 */
async function runAndAccept(command: string): Promise<void> {
  const running = Promise.resolve(vscode.commands.executeCommand(command));
  const finished = running.then(() => true);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    const tick = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, 100);
    });
    if (await Promise.race([finished, tick])) {
      break;
    }
  }
  await running;
}

function tabLabels(): string[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
}

/**
 * A stand-in claude that adds one tab separated line of arguments per call
 * and then waits on stdin. Overlord also polls claude agents, so a call can
 * land on either side of the launch.
 */
function stubClaude(): { readonly bin: string; readonly argsFile: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overlord-stub-'));
  const bin = path.join(dir, 'claude');
  const argsFile = path.join(dir, 'args');
  const record = `printf '%s\\t' "$@" >> '${argsFile}'\nprintf '\\n' >> '${argsFile}'`;
  writeFileSync(bin, `#!/bin/sh\n${record}\nexec cat\n`, { mode: 0o755 });
  return { bin, argsFile };
}

/** Each call the stub recorded, as its arguments. */
function stubCalls(argsFile: string): string[][] {
  try {
    const text = readFileSync(argsFile, 'utf8');
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split('\t').slice(0, -1));
  } catch {
    return [];
  }
}

describe('Overlord extension', () => {
  it('activates', async () => {
    const extension = vscode.extensions.getExtension<unknown>(EXTENSION_ID);
    assert.ok(extension, 'extension is installed in the test host');
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  it('registers every command it contributes', async () => {
    const extension = vscode.extensions.getExtension<unknown>(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();
    // @types/vscode declares packageJSON as any, so read it as unknown and narrow.
    // type-coverage:ignore-next-line
    const manifest: unknown = extension.packageJSON;
    assert.ok(typeof manifest === 'object' && manifest !== null && 'contributes' in manifest);
    const contributed = JSON.stringify(manifest.contributes);
    const registered = new Set(await vscode.commands.getCommands(true));
    const ids = [...contributed.matchAll(/"command":"(overlord\.[A-Za-z]+)"/gu)].map(
      (match) => match[1] ?? '',
    );
    assert.ok(ids.length > 10, 'manifest lists the commands');
    for (const id of new Set(ids)) {
      assert.ok(registered.has(id), `${id} is registered`);
    }
  });

  it('opens the fleet view without throwing', async () => {
    await vscode.commands.executeCommand('overlord.openFleet');
    // The tab list updates after the command returns, so poll for it.
    const deadline = Date.now() + 5000;
    let labels: string[] = [];
    while (Date.now() < deadline) {
      labels = vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
      if (labels.includes('Overlord: Fleet')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(labels.includes('Overlord: Fleet'), `tabs were: ${labels.join(', ')}`);
  });

  it('opens a new Claude Code session as an editor tab with its properties in the sidebar', async () => {
    // Tests must never start the real CLI, so point the setting at a stub.
    const stub = stubClaude();
    const config = vscode.workspace.getConfiguration('overlord');
    await config.update('claudePath', stub.bin, vscode.ConfigurationTarget.Global);
    try {
      // It asks which folder first, and the first choice is this window.
      await runAndAccept('overlord.newClaudeSession');
      const terminal = vscode.window.terminals.find((entry) => entry.name === 'Claude Code');
      assert.ok(terminal, 'a Claude Code terminal was created');
      await waitFor(() => vscode.window.activeTerminal?.name === 'Claude Code');
      assert.equal(vscode.window.activeTerminal?.name, 'Claude Code');
      // Properties live in the sidebar now, so no editor tab opens beside the CLI.
      assert.ok(
        !tabLabels().includes('Overlord: Properties'),
        `tabs were: ${tabLabels().join(', ')}`,
      );
      const cli = vscode.window.tabGroups.all.find((group) =>
        // A terminal tab's label follows its process, so find it by input type.
        group.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal),
      );
      assert.ok(cli !== undefined, 'the CLI is an editor tab');
      await vscode.commands.executeCommand('overlord.showProperties');
      const launch = (): string[] | undefined =>
        stubCalls(stub.argsFile).find((call) => call[0] === '--session-id');
      await waitFor(() => launch() !== undefined);
      const args = launch();
      assert.ok(args, `claude calls were: ${JSON.stringify(stubCalls(stub.argsFile))}`);
      assert.match(args[1] ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-/u);
      terminal.dispose();
    } finally {
      await config.update('claudePath', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('docks the Fleet in the Overlord sidebar', async () => {
    // VS Code adds a focus command for every contributed view.
    await vscode.commands.executeCommand('overlord.fleet.focus');
    await vscode.commands.executeCommand('overlord.global.focus');
    await vscode.commands.executeCommand('overlord.properties.focus');
    const commands = new Set(await vscode.commands.getCommands(true));
    const views = ['overlord.fleet', 'overlord.global', 'overlord.properties'];
    for (const view of views) {
      assert.ok(commands.has(`${view}.focus`), `${view} is a contributed view`);
    }
  });
});
