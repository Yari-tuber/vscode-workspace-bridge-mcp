'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createVscodeHost } = require('../src/vscode-host');
const { startServer } = require('../src/server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

async function run({ vscode, root, check }) {
  // These checks are permitted to modify only a fresh integration fixture,
  // never an arbitrary project or the user's normal VS Code profile.
  const realRoot = await fs.realpath(root);
  const temp = await fs.realpath(os.tmpdir());
  const relative = path.relative(temp, realRoot);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.ok(relative.split(path.sep).some(part => part.startsWith('workspace-bridge-integration-')));
  const prefix = `bridge-refactor-v4-${crypto.randomBytes(5).toString('hex')}`;
  const names = { source: `${prefix}-source.txt`, usage: `${prefix}-usage.txt`, format: `${prefix}-format.txt`, fix: `${prefix}-fix.txt` };
  const original = { source: 'count = 1\n', usage: 'print(count)\n', format: 'value=1\n', fix: 'bad\n' };
  for (const name of Object.keys(names)) await fs.writeFile(path.join(realRoot, names[name]), original[name]);
  const uri = name => vscode.Uri.file(path.join(realRoot, names[name]));
  const selector = { scheme: 'file', language: 'plaintext', pattern: `**/${prefix}-*.txt` };
  const providers = [];
  const access = { read: true, edit: false, terminal: false, git: false, refactor: true, tasks: false };
  const controlledVscode = Object.create(vscode);
  Object.defineProperty(controlledVscode, 'window', { value: Object.create(vscode.window) });
  Object.defineProperty(controlledVscode.window, 'showWarningMessage', { value: async (_message, options, ...buttons) => {
    assert.match(options.detail, /Semantic rename|Document formatting|Synthetic safe fix/);
    assert.ok(options.detail.includes(prefix));
    return buttons[0];
  } });
  const host = createVscodeHost({ vscode: controlledVscode, getAccess: () => access });
  const token = crypto.randomBytes(32).toString('hex');
  const server = await startServer({ host, token, port: 0 });
  const client = new Client({ name: 'refactor-runtime-test', version: '1.0.0' });
  const unpack = response => { if (response.isError) throw new Error(response.content[0].text); return JSON.parse(response.content[0].text); };
  const call = async (name, args) => unpack(await client.callTool({ name, arguments: args }));
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const overview = await call('workspace_overview', {});
    const scope = { workspaceId: overview.workspaceId };
    const read = name => call('read_file', { ...scope, path: names[name] });
    providers.push(vscode.languages.registerRenameProvider(selector, {
      prepareRename(document, position) { return document.getWordRangeAtPosition(position); },
      async provideRenameEdits(document, position, newName) {
        assert.equal(document.uri.fsPath, uri('source').fsPath);
        const wordRange = document.getWordRangeAtPosition(position);
        const oldName = document.getText(wordRange);
        const edit = new vscode.WorkspaceEdit();
        for (const name of ['source', 'usage']) {
          const target = await vscode.workspace.openTextDocument(uri(name));
          const start = target.getText().indexOf(oldName);
          assert.ok(start >= 0);
          edit.replace(target.uri, new vscode.Range(target.positionAt(start), target.positionAt(start + oldName.length)), newName);
        }
        // This verifies the real VS Code representation used by the guard,
        // rather than assuming the fake WorkspaceEdit mirrors its internals.
        assert.equal(typeof edit._allEntries, 'function');
        assert.equal(edit._allEntries().every(entry => entry._type === 2), true);
        return edit;
      },
    }));
    await check('v4 real semantic rename previews two files and applies one unsaved editor transaction over MCP', async () => {
      const snapshot = await read('source');
      const prepared = await call('prepare_rename', { ...scope, path: names.source, expectedHash: snapshot.hash, line: 0, character: 1, newName: 'total' });
      assert.equal(prepared.fileCount, 2); assert.equal(prepared.applied, false);
      assert.equal(await fs.readFile(uri('source').fsPath, 'utf8'), original.source);
      const result = await call('apply_refactor', { ...scope, refactorId: prepared.refactorId });
      assert.equal(result.applied, true); assert.equal(result.saved, false); assert.equal(result.verified, true); assert.equal(result.requiresSave, true);
      const sourceDocument = await vscode.workspace.openTextDocument(uri('source'));
      const usageDocument = await vscode.workspace.openTextDocument(uri('usage'));
      assert.equal(sourceDocument.getText(), 'total = 1\n'); assert.equal(sourceDocument.isDirty, true);
      assert.equal(usageDocument.getText(), 'print(total)\n'); assert.equal(usageDocument.isDirty, true);
      assert.equal(await fs.readFile(uri('source').fsPath, 'utf8'), original.source);
      assert.equal(await fs.readFile(uri('usage').fsPath, 'utf8'), original.usage);
      assert.equal(JSON.stringify(result).includes(realRoot), false);
    });
    await check('v4 a changed related editor rejects the entire real multi-file rename', async () => {
      const snapshot = await read('source');
      const prepared = await call('prepare_rename', { ...scope, path: names.source, expectedHash: snapshot.hash, line: 0, character: 1, newName: 'sum' });
      const local = new vscode.WorkspaceEdit(); local.insert(uri('usage'), new vscode.Position(1, 0), '// changed after preview\n');
      assert.equal(await vscode.workspace.applyEdit(local), true);
      const rejected = await client.callTool({ name: 'apply_refactor', arguments: { ...scope, refactorId: prepared.refactorId } });
      assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /EDIT_CONFLICT/);
      assert.equal((await vscode.workspace.openTextDocument(uri('source'))).getText(), 'total = 1\n');
      assert.equal(await fs.readFile(uri('source').fsPath, 'utf8'), original.source);
    });
    providers.push(vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits(document) {
        if (document.uri.fsPath !== uri('format').fsPath) return [];
        return [vscode.TextEdit.replace(new vscode.Range(0, 0, 0, 7), 'value = 1')];
      },
    }));
    await check('v4 real document formatter creates a reviewable preview and leaves disk unchanged after apply', async () => {
      const snapshot = await read('format');
      const prepared = await call('format_document', { ...scope, path: names.format, expectedHash: snapshot.hash });
      assert.equal(prepared.previewed, true);
      const result = await call('apply_refactor', { ...scope, refactorId: prepared.refactorId });
      assert.equal(result.verified, true);
      assert.equal((await vscode.workspace.openTextDocument(uri('format'))).getText(), 'value = 1\n');
      assert.equal(await fs.readFile(uri('format').fsPath, 'utf8'), original.format);
    });
    providers.push(vscode.languages.registerCodeActionsProvider(selector, {
      provideCodeActions(document) {
        if (document.uri.fsPath !== uri('fix').fsPath) return [];
        const safe = new vscode.CodeAction('Synthetic safe fix', vscode.CodeActionKind.QuickFix);
        safe.edit = new vscode.WorkspaceEdit(); safe.edit.replace(document.uri, new vscode.Range(0, 0, 0, 3), 'good');
        const commandBearing = new vscode.CodeAction('Synthetic excluded command', vscode.CodeActionKind.QuickFix);
        commandBearing.command = { title: 'Never execute', command: 'synthetic.shouldNeverRun' };
        commandBearing.edit = safe.edit;
        return [safe, commandBearing];
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
    await check('v4 real code actions exclude command-bearing actions and apply only the reviewed text fix', async () => {
      const snapshot = await read('fix');
      const listed = await call('get_code_actions', { ...scope, path: names.fix, expectedHash: snapshot.hash, line: 0, character: 1 });
      assert.equal(listed.actions.length, 1); assert.equal(listed.excludedActions, 1);
      const prepared = await call('prepare_code_action', { ...scope, actionId: listed.actions[0].actionId });
      const result = await call('apply_refactor', { ...scope, refactorId: prepared.refactorId });
      assert.equal(result.verified, true);
      assert.equal((await vscode.workspace.openTextDocument(uri('fix'))).getText(), 'good\n');
      assert.equal(await fs.readFile(uri('fix').fsPath, 'utf8'), original.fix);
    });
    await check('v4 disabling the independent refactor grant blocks language mutation tools', async () => {
      const snapshot = await read('source'); access.refactor = false;
      const result = await client.callTool({ name: 'prepare_rename', arguments: { ...scope, path: names.source, expectedHash: snapshot.hash, line: 0, character: 1, newName: 'blocked' } });
      assert.equal(result.isError, true); assert.match(result.content[0].text, /ACCESS_DENIED/);
      assert.equal((await vscode.workspace.openTextDocument(uri('source'))).getText(), 'total = 1\n');
    });
  } finally {
    providers.forEach(provider => provider.dispose());
    await client.close(); await server.close(); host.dispose();
  }
}

module.exports = { run };
