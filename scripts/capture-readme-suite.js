'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
async function run() {
  const extension = vscode.extensions.getExtension('workspace-bridge.vscode-workspace-bridge-mcp');
  const api = await extension.activate();
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'src', 'cart.js')));
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand('workbench.view.extension.workspaceBridge');
  await vscode.commands.executeCommand('workspaceBridge.start');
  if (!api.getStatus().running) throw new Error('Demo bridge did not start.');
  await fs.writeFile(process.env.BRIDGE_DEMO_READY, JSON.stringify({ title: 'Workspace Bridge MCP · Demo', running: true, version: extension.packageJSON.version }));
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try { await fs.access(process.env.BRIDGE_DEMO_STOP); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await vscode.commands.executeCommand('workspaceBridge.stop');
}
module.exports = { run };
