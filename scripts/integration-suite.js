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
  await check('the control-center command opens a real VS Code webview editor', async () => {
    await vscode.commands.executeCommand('workspaceBridge.openDashboard');
    const deadline = Date.now() + 5000;
    while (!vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'Workspace Bridge')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'Workspace Bridge')));
  });
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
    await check('active editor context is metadata-first and selection text requires an explicit request', async () => {
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'hello.js')), { preview: false });
      editor.selection = new vscode.Selection(0, 6, 0, 12);
      const metadata = data(await client.callTool({ name: 'get_editor_context', arguments: { workspaceId: overview.workspaceId } }));
      assert.equal(metadata.path, 'hello.js'); assert.equal(Object.hasOwn(metadata, 'selectedText'), false);
      const selected = data(await client.callTool({ name: 'get_editor_context', arguments: { workspaceId: overview.workspaceId, includeSelection: true } }));
      assert.equal(selected.selectedText, 'answer'); assert.equal(JSON.stringify(selected).includes(root), false);
    });
    await check('hover uses the real VS Code language-provider API without returning trusted objects', async () => {
      const provider = vscode.languages.registerHoverProvider({ language: 'javascript', scheme: 'file' }, {
        provideHover: () => new vscode.Hover('Synthetic hover information', new vscode.Range(0, 6, 0, 12))
      });
      try {
        const result = data(await client.callTool({ name: 'get_hover', arguments: { ...args, line: 0, character: 8 } }));
        assert.equal(result.hovers.some(item => item.contents.some(text => text.includes('Synthetic hover information'))), true);
        assert.equal(result.untrusted, true); assert.equal(JSON.stringify(result).includes('baseUri'), false);
      } finally { provider.dispose(); }
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
    await check('unique replacement previews without writing and explicitly applies through the real editor', async () => {
      const snapshot = data(await client.callTool({ name: 'read_file', arguments: args }));
      const request = { ...args, oldText: '43', newText: '44', expectedHash: snapshot.hash };
      const preview = data(await client.callTool({ name: 'replace_text', arguments: request }));
      assert.equal(preview.applied, false); assert.match(await fs.readFile(path.join(root, 'hello.js'), 'utf8'), /43/);
      const saved = data(await client.callTool({ name: 'replace_text', arguments: { ...request, previewOnly: false } }));
      assert.equal(saved.applied, true); assert.equal(saved.hash, hashText(await fs.readFile(path.join(root, 'hello.js'), 'utf8')));
    });
    await check('range edits preview by default and save only after an explicit apply', async () => {
      const snapshot = data(await client.callTool({ name: 'read_file', arguments: args }));
      const request = { ...args, expectedHash: snapshot.hash, edits: [{ range: { start: { line: 0, character: 15 }, end: { line: 0, character: 17 } }, text: '45' }] };
      const preview = data(await client.callTool({ name: 'apply_text_edits', arguments: request }));
      assert.equal(preview.applied, false); assert.match(await fs.readFile(path.join(root, 'hello.js'), 'utf8'), /44/);
      const saved = data(await client.callTool({ name: 'apply_text_edits', arguments: { ...request, previewOnly: false } }));
      assert.equal(saved.applied, true); assert.match(await fs.readFile(path.join(root, 'hello.js'), 'utf8'), /45/);
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
    await check('batch reads return independent hashes and isolate forbidden files', async () => {
      const result = data(await client.callTool({ name: 'read_files', arguments: { workspaceId: overview.workspaceId, files: [{ path: 'hello.js' }, { path: 'created.txt' }, { path: '.env' }] } }));
      assert.equal(result.files[0].hash, hashText(await fs.readFile(path.join(root, 'hello.js'), 'utf8')));
      assert.equal(result.files[1].path, 'created.txt'); assert.equal(result.files[2].error.code, 'SENSITIVE_PATH');
    });
    await check('workspace symbols and type/implementation navigation use real registered providers', async () => {
      const uri = vscode.Uri.file(path.join(root, 'hello.js'));
      const range = new vscode.Range(0, 6, 0, 12);
      const location = new vscode.Location(uri, range);
      const providers = [
        vscode.languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: () => [new vscode.SymbolInformation('IntegrationProbe', vscode.SymbolKind.Variable, '', location)] }),
        vscode.languages.registerTypeDefinitionProvider({ language: 'javascript', scheme: 'file' }, { provideTypeDefinition: () => [location] }),
        vscode.languages.registerImplementationProvider({ language: 'javascript', scheme: 'file' }, { provideImplementation: () => [location] })
      ];
      try {
        const symbols = data(await client.callTool({ name: 'search_workspace_symbols', arguments: { workspaceId: overview.workspaceId, query: 'IntegrationProbe' } }));
        assert.ok(symbols.symbols.some(symbol => symbol.name === 'IntegrationProbe' && symbol.path === 'hello.js'));
        for (const name of ['get_type_definition', 'get_implementations']) {
          const result = data(await client.callTool({ name, arguments: { ...args, line: 0, character: 8 } }));
          assert.ok(result.locations.some(item => item.path === 'hello.js'));
        }
      } finally { providers.forEach(provider => provider.dispose()); }
    });
    await check('safe directories and a non-overwriting file move work through the real editor APIs', async () => {
      const created = data(await client.callTool({ name: 'create_directory', arguments: { workspaceId: overview.workspaceId, path: 'generated/api' } }));
      assert.ok(created.created.length >= 1);
      const snapshot = data(await client.callTool({ name: 'read_file', arguments: { ...args, path: 'created.txt' } }));
      const moved = data(await client.callTool({ name: 'move_file', arguments: { ...args, path: 'created.txt', targetPath: 'generated/api/moved.txt', expectedHash: snapshot.hash } }));
      assert.equal(moved.moved, true); assert.equal(moved.to.path, 'generated/api/moved.txt');
      await assert.rejects(() => fs.access(path.join(root, 'created.txt')));
      assert.match(await fs.readFile(path.join(root, 'generated', 'api', 'moved.txt'), 'utf8'), /Created in the isolated/);
    });
    await check('an allowed file can be opened locally for review without changing it', async () => {
      const result = data(await client.callTool({ name: 'open_file', arguments: { ...args, line: 0 } }));
      assert.equal(result.opened, true); assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, path.join(root, 'hello.js'));
    });
    await check('a background task completes over MCP with controlled synthetic local approval', async () => {
      // Inherit lazily: enumerating VS Code namespaces invokes proposed-API
      // getters that are unrelated to this controlled approval fixture.
      const testVscode = Object.create(vscode);
      Object.defineProperty(testVscode, 'window', { value: Object.create(vscode.window) });
      Object.defineProperty(testVscode.window, 'showWarningMessage', { value: async (_message, options, ...actions) => {
        assert.match(options.detail, /echo bridge-task-fixture/); return actions[0];
      } });
      const taskHost = createVscodeHost({ vscode: testVscode, getAccess: () => ({ read: true, edit: false, terminal: true }) });
      // Use a fresh server credential, held only in the test process.
      const taskToken = crypto.randomBytes(32).toString('hex');
      const liveServer = await startServer({ host: taskHost, token: taskToken, port: 0 });
      const taskClient = new Client({ name: 'task-runtime-test', version: '1.0.0' });
      try {
        await taskClient.connect(new StreamableHTTPClientTransport(new URL(liveServer.url), { requestInit: { headers: { Authorization: `Bearer ${taskToken}` } } }));
        const taskWorkspace = data(await taskClient.callTool({ name: 'workspace_overview', arguments: {} }));
        const task = data(await taskClient.callTool({ name: 'start_terminal_task', arguments: { workspaceId: taskWorkspace.workspaceId, command: 'echo bridge-task-fixture', timeoutMs: 5000 } }));
        assert.equal(task.state, 'awaiting_approval');
        let result; const deadline = Date.now() + 10000;
        do {
          await new Promise(resolve => setTimeout(resolve, 50));
          result = data(await taskClient.callTool({ name: 'get_terminal_task', arguments: { workspaceId: taskWorkspace.workspaceId, id: task.id, includeOutput: true } }));
        } while (['awaiting_approval', 'running', 'stopping'].includes(result.state) && Date.now() < deadline);
        assert.equal(result.state, 'completed'); assert.equal(result.exitCode, 0); assert.match(result.output, /bridge-task-fixture/);
        assert.equal(Object.hasOwn(result, 'command'), false); assert.equal(Object.hasOwn(result, 'cwd'), false);
      } finally { await taskClient.close(); await liveServer.close(); taskHost.dispose(); }
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
