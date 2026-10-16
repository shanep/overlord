// Runs inside a real VS Code instance through @vscode/test-cli.
import assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'shanep.overlord';

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

  it('opens a new Claude Code session as an editor tab', async () => {
    // Tests must never start the real CLI, so point the setting at a plain shell.
    const config = vscode.workspace.getConfiguration('overlord');
    await config.update('claudePath', '/bin/sh', vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('overlord.newClaudeSession');
      const terminal = vscode.window.terminals.find((entry) => entry.name === 'Claude Code');
      assert.ok(terminal, 'a Claude Code terminal was created');
      const deadline = Date.now() + 5000;
      while (vscode.window.activeTerminal?.name !== 'Claude Code' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(vscode.window.activeTerminal?.name, 'Claude Code');
      terminal.dispose();
    } finally {
      await config.update('claudePath', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('docks the Fleet in the Overlord sidebar', async () => {
    // VS Code adds a focus command for every contributed view.
    await vscode.commands.executeCommand('overlord.fleet.focus');
    await vscode.commands.executeCommand('overlord.global.focus');
    await vscode.commands.executeCommand('overlord.sessionViews.focus');
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const view of ['overlord.fleet', 'overlord.global', 'overlord.sessionViews']) {
      assert.ok(commands.has(`${view}.focus`), `${view} is a contributed view`);
    }
  });
});
