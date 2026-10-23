'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { invokeTool, getToolCatalog } = require('../src/tools');
const { hashText } = require('../src/security');
const value = response => JSON.parse(response.content[0].text);
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-tools-v3-')));
  const workspace = { id: 'v3-session', trusted: true, roots: [{ name: 'demo', path: root }] };
  const access = { read: true, edit: false, terminal: false };
  const calls = [];
  const host = { getWorkspace: () => workspace, getAccess: () => access,
    readDocument: async ({ path: file }) => ({ text: await fs.readFile(file, 'utf8'), version: 1, isDirty: false }),
    createDirectory: async args => { calls.push(args); return { created: true }; },
    moveFile: async args => { calls.push(args); return { moved: true }; },
    deleteFile: async args => { calls.push(args); return { trashed: true }; },
    startTerminalTask: async args => { calls.push(args); return { id: 'a'.repeat(32), state: 'awaiting_approval' }; },
    getTerminalTask: args => { calls.push(args); return { id: args.id, state: 'running' }; },
    listTerminalTasks: () => [], cancelTerminalTask: args => { calls.push(args); return { id: args.id, state: 'cancelled' }; }
  };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, workspace, access, host, calls };
}
test('batch reads preserve file hashes and isolate per-file denials without echoing unsafe paths', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.js'), 'const answer = 42;\n');
  const result = value(await invokeTool(f.host, 'read_files', { workspaceId: f.workspace.id, files: [{ path: 'a.js' }, { path: '.env' }, { path: '../private' }] }));
  assert.equal(result.files[0].hash, hashText('const answer = 42;\n'));
  assert.equal(result.files[1].error.code, 'SENSITIVE_PATH'); assert.equal(result.files[2].error.code, 'OUTSIDE_WORKSPACE');
  assert.equal(Object.hasOwn(result.files[2], 'path'), false); assert.equal(JSON.stringify(result).includes(f.root), false);
});
test('batch content budget counts UTF-8 bytes and never splits a multibyte character', async t => {
  const f = await fixture(t); const text = '界'.repeat(40000);
  await fs.writeFile(path.join(f.root, 'a.txt'), text); await fs.writeFile(path.join(f.root, 'b.txt'), text);
  const result = value(await invokeTool(f.host, 'read_files', { workspaceId: f.workspace.id, files: [{ path: 'a.txt' }, { path: 'b.txt' }] }));
  const total = result.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
  assert.ok(total <= 90000); assert.equal(result.files[0].content.includes('\ufffd'), false);
  assert.equal(result.files[1].truncated, true); assert.ok(result.remainingBytes <= 3);
});
test('a workspace reset during batch reading rejects all partial results', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.txt'), 'should not escape');
  const read = f.host.readDocument; f.host.readDocument = async args => { const result = await read(args); f.workspace.id = 'changed'; return result; };
  const response = await invokeTool(f.host, 'read_files', { workspaceId: 'v3-session', files: [{ path: 'a.txt' }] });
  assert.equal(response.isError, true); assert.equal(value(response).error.code, 'WORKSPACE_CHANGED');
  assert.equal(JSON.stringify(response).includes('should not escape'), false);
});
test('directory and file lifecycle schemas cannot bypass local edit permission or unsafe destination paths', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.txt'), 'safe');
  const scope = { workspaceId: f.workspace.id, path: 'a.txt', expectedHash: hashText('safe') };
  assert.equal(value(await invokeTool(f.host, 'create_directory', { workspaceId: f.workspace.id, path: 'new/child' })).error.code, 'ACCESS_DENIED');
  f.access.edit = true;
  assert.equal((await invokeTool(f.host, 'create_directory', { workspaceId: f.workspace.id, path: 'new/child' })).isError, false);
  assert.equal(f.calls[0].path, path.join(f.root, 'new', 'child'));
  assert.equal(value(await invokeTool(f.host, 'move_file', { ...scope, targetPath: '../outside' })).error.code, 'OUTSIDE_WORKSPACE');
  assert.equal((await invokeTool(f.host, 'move_file', { ...scope, targetPath: 'renamed.txt' })).isError, false);
  assert.equal(f.calls.at(-1).expectedHash, scope.expectedHash);
  assert.equal((await invokeTool(f.host, 'delete_file', scope)).isError, false);
});
test('async tasks return queued state without approval claims, default to metadata, and retain scope checks', async t => {
  const f = await fixture(t); const scope = { workspaceId: f.workspace.id };
  assert.equal(value(await invokeTool(f.host, 'start_terminal_task', { ...scope, command: 'echo demo' })).error.code, 'ACCESS_DENIED');
  f.access.terminal = true;
  const queued = value(await invokeTool(f.host, 'start_terminal_task', { ...scope, command: 'echo demo' }));
  assert.equal(queued.state, 'awaiting_approval'); assert.equal(f.calls[0].timeoutMs, 120000);
  await invokeTool(f.host, 'get_terminal_task', { ...scope, id: queued.id });
  assert.equal(f.calls.at(-1).includeOutput, false);
  assert.equal(value(await invokeTool(f.host, 'get_terminal_task', { ...scope, id: 'external-pid-1' })).error.code, 'INVALID_ARGUMENTS');
  f.access.read = false;
  assert.equal(value(await invokeTool(f.host, 'cancel_terminal_task', { ...scope, id: queued.id })).error.code, 'ACCESS_DENIED');
  assert.equal(getToolCatalog().length, require('../src/tools').definitions.length);
});
