'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createVscodeHost } = require('../src/vscode-host');
const { startServer } = require('../src/server');
const { hashText } = require('../src/security');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

async function run() {
  const checks = [];
  const check = (name, action) => Promise.resolve().then(action).then(() => { checks.push({ name, passed: true }); console.log(`PASS ${name}`); });
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const extension = vscode.extensions.getExtension('workspace-bridge.vscode-workspace-bridge-mcp');
  assert.ok(extension);
  const api = await extension.activate();
  await check('extension activates with access disabled', () => {
    assert.equal(api.getStatus().running, false); assert.equal(api.getStatus().access.read, false);
  });
  await check('extension starts a read-only authenticated endpoint', async () => {
    await vscode.commands.executeCommand('workspaceBridge.start');
    const state = api.getStatus(); assert.equal(state.running, true); assert.equal(state.access.edit, false); assert.equal(state.access.terminal, false);
    assert.equal((await fetch(state.url)).status, 401);
  });
  const before = api.getStatus().workspaceId;
  await check('rotation replaces the workspace session and leaves read-only access', async () => {
    await vscode.commands.executeCommand('workspaceBridge.rotateToken');
    assert.notEqual(api.getStatus().workspaceId, before); assert.equal(api.getStatus().access.edit, false);
  });
  await check('stop revokes all access and closes the endpoint', async () => {
    const url = api.getStatus().url;
    await vscode.commands.executeCommand('workspaceBridge.stop');
    assert.equal(api.getStatus().running, false); assert.equal(api.getStatus().access.read, false);
    await assert.rejects(() => fetch(url));
  });

  const access = { read: true, edit: false, terminal: false };
  const host = createVscodeHost({ vscode, getAccess: () => access });
  const token = crypto.randomBytes(32).toString('hex');
  const server = await startServer({ host, token, port: 0 });
  const client = new Client({ name: 'vscode-runtime-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const data = response => { if (response.isError) throw new Error(response.content[0].text); return JSON.parse(response.content[0].text); };
    const overview = data(await client.callTool({ name: 'workspace_overview', arguments: {} }));
    const args = { workspaceId: overview.workspaceId, path: 'hello.js' };
    await check('real editor buffer read through official MCP client', async () => {
      const read = data(await client.callTool({ name: 'read_file', arguments: args }));
      assert.equal(read.hash, hashText('const answer = 42;\nconsole.log(answer);\n'));
      assert.equal(JSON.stringify(read).includes(root), false);
    });
    await check('read-only denies a real editor mutation', async () => {
      const result = await client.callTool({ name: 'write_file', arguments: { ...args, expectedHash: 'new', text: 'not allowed' } });
      assert.equal(result.isError, true); assert.match(result.content[0].text, /ACCESS_DENIED/);
    });
    access.edit = true;
    const current = data(await client.callTool({ name: 'read_file', arguments: args }));
    await check('real editor diff and hash-guarded save', async () => {
      const text = 'const answer = 43;\nconsole.log(answer);\n';
      data(await client.callTool({ name: 'preview_edit', arguments: { ...args, text, expectedHash: current.hash } }));
      data(await client.callTool({ name: 'write_file', arguments: { ...args, text, expectedHash: current.hash } }));
      assert.equal(await fs.readFile(path.join(root, 'hello.js'), 'utf8'), text);
    });
    await check('stale content hash cannot overwrite a real edited document', async () => {
      const result = await client.callTool({ name: 'write_file', arguments: { ...args, text: 'stale overwrite', expectedHash: current.hash } });
      assert.equal(result.isError, true); assert.match(result.content[0].text, /EDIT_CONFLICT/);
    });
    await check('new file preview and creation are supported without overwriting', async () => {
      const newArgs = { ...args, path: 'created.txt', expectedHash: 'new', text: 'Created in the isolated test workspace.\n' };
      data(await client.callTool({ name: 'preview_edit', arguments: newArgs }));
      data(await client.callTool({ name: 'write_file', arguments: newArgs }));
      const saved = await fs.readFile(path.join(root, 'created.txt'), 'utf8');
      assert.equal(saved.replaceAll('\r\n', '\n'), newArgs.text);
      const read = data(await client.callTool({ name: 'read_file', arguments: { ...args, path: 'created.txt' } }));
      assert.equal(read.hash, hashText(saved));
      assert.equal((await client.callTool({ name: 'write_file', arguments: newArgs })).isError, true);
    });
    await check('diagnostics filter outside files and return relative paths', async () => {
      const collection = vscode.languages.createDiagnosticCollection('bridge-runtime-test');
      try {
        collection.set(vscode.Uri.file(path.join(root, 'hello.js')), [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), 'Synthetic diagnostic', vscode.DiagnosticSeverity.Warning)]);
        const result = data(await client.callTool({ name: 'get_diagnostics', arguments: { workspaceId: overview.workspaceId } }));
        assert.equal(result.diagnostics.some(d => d.path === 'hello.js'), true);
        assert.equal(JSON.stringify(result).includes(root), false);
      } finally { collection.dispose(); }
    });
    await check('session reset invalidates old client mutations', async () => {
      host.resetSession();
      const result = await client.callTool({ name: 'write_file', arguments: { ...args, text: 'old session', expectedHash: current.hash } });
      assert.equal(result.isError, true); assert.match(result.content[0].text, /WORKSPACE_CHANGED/);
    });
    await fs.mkdir(path.dirname(process.env.WORKSPACE_BRIDGE_TEST_REPORT), { recursive: true });
    await fs.writeFile(process.env.WORKSPACE_BRIDGE_TEST_REPORT, JSON.stringify({ platform: process.platform, vscode: vscode.version, passed: checks.length, checks }, null, 2));
  } finally { await client.close(); await server.close(); host.dispose(); }
}
module.exports = { run };
