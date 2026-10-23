'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const security = require('../src/security');
const { createWorkspaceOps, MAX_TEXT_BYTES, TRASH_APPROVAL_TIMEOUT_MS } = require('../src/workspace-ops');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-lifecycle-')));
  const root = path.join(base, 'workspace');
  const trash = path.join(base, 'synthetic-trash');
  await fs.mkdir(root);
  await fs.mkdir(trash);
  const state = { id: 'synthetic-workspace', access: { read: true, edit: true }, trusted: true };
  const documents = new Map();
  const calls = { directories: [], edits: [], deletes: [], warnings: [] };
  const pendingApprovals = new Set();
  const locks = new Map();
  const fail = (code, message) => { throw new security.BridgeError(code, message); };
  class Uri {
    constructor(value) { this.fsPath = path.resolve(value); this.scheme = 'file'; }
    static file(value) { return new Uri(value); }
    toString() { return `file:${this.fsPath}`; }
  }
  class WorkspaceEdit {
    constructor() { this.operations = []; }
    renameFile(from, to, options) { this.operations.push({ from, to, options }); }
  }
  const vscode = {
    Uri, WorkspaceEdit, env: { language: 'en' },
    workspace: {
      textDocuments: [],
      async applyEdit(edit) {
        calls.edits.push(edit);
        if (vscode.beforeApply) await vscode.beforeApply(edit);
        for (const operation of edit.operations) {
          assert.deepEqual(operation.options, { overwrite: false, ignoreIfExists: false });
          // link() atomically fails for an occupied destination. Unlike rename()
          // on POSIX, the mock must honor VS Code's overwrite:false contract.
          try { await fs.link(operation.from.fsPath, operation.to.fsPath); } catch { return false; }
          await fs.unlink(operation.from.fsPath);
          const document = documents.get(operation.from.toString());
          if (document) {
            documents.delete(operation.from.toString());
            document.uri = operation.to;
            documents.set(operation.to.toString(), document);
          }
        }
        return true;
      },
      fs: {
        async createDirectory(uri) { calls.directories.push(uri.fsPath); await fs.mkdir(uri.fsPath); },
        async delete(uri, options) {
          calls.deletes.push({ path: uri.fsPath, options });
          assert.deepEqual(options, { useTrash: true, recursive: false });
          if (vscode.trashUnavailable) throw new Error('Synthetic Trash unavailable');
          // Tests only move an exact synthetic file into a synthetic trash folder.
          await fs.rename(uri.fsPath, path.join(trash, path.basename(uri.fsPath)));
        },
      },
    },
    window: {
      async showWarningMessage(...args) {
        calls.warnings.push(args);
        return vscode.onWarning ? vscode.onWarning(...args) : undefined;
      },
    },
  };
  const host = {
    getWorkspace: () => ({ id: state.id, roots: [{ name: 'Synthetic', path: root }], trusted: state.trusted }),
    getAccess: () => state.access,
  };
  const snapshot = (id, capability) => {
    if (typeof id !== 'string' || !id) fail('WORKSPACE_REQUIRED', 'A workspace id is required.');
    return security.assertWorkspace(host, id, { capability });
  };
  const recheck = (workspace, capability) => security.assertWorkspace(host, workspace.id, { capability });
  const relativeInput = (workspace, absolutePath) => security.toRelative(workspace, absolutePath);
  const checkedPath = async (workspace, absolutePath, options = {}) => {
    const relative = relativeInput(workspace, absolutePath);
    if (!relative) fail('OUTSIDE_WORKSPACE', 'Excluded path.');
    const canonical = await security.resolvePath(workspace, relative.path, { ...options, root: relative.root });
    recheck(workspace, options.capability || 'read');
    if (vscode.onChecked) await vscode.onChecked(canonical, options);
    return canonical;
  };
  const readForWorkspace = async (workspace, inputPath, capability) => {
    const absolutePath = await checkedPath(workspace, inputPath, { capability });
    const uri = Uri.file(absolutePath);
    if (!documents.has(uri.toString())) {
      const document = { uri, text: await fs.readFile(absolutePath, 'utf8'), version: 1, isDirty: false, getText() { return this.text; } };
      documents.set(uri.toString(), document);
      vscode.workspace.textDocuments.push(document);
    }
    const document = documents.get(uri.toString());
    return { text: document.text, version: document.version, isDirty: document.isDirty };
  };
  const withFileLock = async (absolutePath, operation) => {
    const key = path.normalize(absolutePath).toLowerCase();
    const prior = locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    locks.set(key, current);
    await prior;
    try { return await operation(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
  };
  const ops = createWorkspaceOps({ vscode, snapshot, checkedPath, readForWorkspace, recheck, withFileLock, relativeInput,
    toRelative: security.toRelative, hashText: security.hashText, assertSafeContent: security.assertSafeContent, pendingApprovals, fail });
  t.after(async () => {
    for (const cancel of pendingApprovals) cancel();
    assert.equal(path.basename(base).startsWith('bridge-lifecycle-'), true);
    await fs.rm(base, { recursive: true, force: true });
  });
  const args = relative => ({ workspaceId: state.id, path: path.join(root, relative) });
  const write = async (relative = 'source.txt', text = 'synthetic text\n') => {
    await fs.writeFile(path.join(root, relative), text);
    return { ...args(relative), expectedHash: security.hashText(text) };
  };
  return { ops, root, trash, vscode, state, calls, documents, pendingApprovals, args, write, readForWorkspace, snapshot };
}

test('creates each missing directory level and reports existing levels without absolute paths', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'src'));
  const result = await f.ops.createDirectory(f.args('src/new/nested'));
  assert.deepEqual(result, { root: 0, path: 'src/new/nested', created: [{ root: 0, path: 'src/new' }, { root: 0, path: 'src/new/nested' }], existed: [{ root: 0, path: 'src' }] });
  assert.deepEqual(f.calls.directories, [path.join(f.root, 'src/new'), path.join(f.root, 'src/new/nested')]);
  assert.equal(JSON.stringify(result).includes(f.root), false);
  const repeated = await f.ops.createDirectory(f.args('src/new/nested'));
  assert.deepEqual(repeated.created, []);
});

test('rejects sensitive names and excessive directory depth before creating any prefix', async t => {
  const f = await fixture(t);
  for (const relative of ['new/.env/child', 'new/secrets/child', 'new/private.key/child', Array(17).fill('deep').join('/')]) {
    await assert.rejects(f.ops.createDirectory(f.args(relative)));
  }
  assert.deepEqual(f.calls.directories, []);
  await assert.rejects(fs.stat(path.join(f.root, 'new')), { code: 'ENOENT' });
});

test('directory creation rejects file parents, outside paths, and disabled access', async t => {
  const f = await fixture(t);
  await f.write('file.txt');
  await assert.rejects(f.ops.createDirectory(f.args('file.txt/child')));
  await assert.rejects(f.ops.createDirectory({ ...f.args(''), path: path.dirname(f.root) }), { code: 'OUTSIDE_WORKSPACE' });
  f.state.access.edit = false;
  await assert.rejects(f.ops.createDirectory(f.args('new')), { code: 'ACCESS_DENIED' });
  assert.deepEqual(f.calls.directories, []);
});

test('moves one text file using a non-overwriting WorkspaceEdit and relative metadata', async t => {
  const f = await fixture(t);
  const input = await f.write();
  await fs.mkdir(path.join(f.root, 'destination'));
  const result = await f.ops.moveFile({ ...input, targetPath: path.join(f.root, 'destination/moved.txt') });
  assert.deepEqual(result, { moved: true, from: { root: 0, path: 'source.txt' }, to: { root: 0, path: 'destination/moved.txt' }, hash: input.expectedHash });
  assert.equal(await fs.readFile(path.join(f.root, 'destination/moved.txt'), 'utf8'), 'synthetic text\n');
  await assert.rejects(fs.stat(input.path), { code: 'ENOENT' });
  assert.equal(f.calls.edits.length, 1);
  assert.deepEqual(f.calls.edits[0].operations[0].options, { overwrite: false, ignoreIfExists: false });
  assert.equal(JSON.stringify(result).includes(f.root), false);
});

test('move rejects stale hashes, dirty editors, case-only names, and missing parent folders', async t => {
  const f = await fixture(t);
  const input = await f.write();
  const targetPath = path.join(f.root, 'moved.txt');
  await assert.rejects(f.ops.moveFile({ ...input, expectedHash: '0'.repeat(64), targetPath }), { code: 'EDIT_CONFLICT' });
  const document = [...f.documents.values()][0];
  document.isDirty = true;
  await assert.rejects(f.ops.moveFile({ ...input, targetPath }), { code: 'UNSAVED_CHANGES' });
  document.isDirty = false;
  await assert.rejects(f.ops.moveFile({ ...input, targetPath: path.join(f.root, 'SOURCE.TXT') }), { code: 'SAME_PATH' });
  await assert.rejects(f.ops.moveFile({ ...input, targetPath: path.join(f.root, 'absent/moved.txt') }), { code: 'PATH_UNAVAILABLE' });
  assert.deepEqual(f.calls.edits, []);
});

test('move never overwrites an existing target, including a target that appears during applyEdit', async t => {
  const f = await fixture(t);
  const input = await f.write();
  const targetPath = path.join(f.root, 'target.txt');
  await fs.writeFile(targetPath, 'keep this');
  await assert.rejects(f.ops.moveFile({ ...input, targetPath }), { code: 'FILE_EXISTS' });
  await fs.unlink(targetPath);
  f.vscode.beforeApply = async () => fs.writeFile(targetPath, 'racing target');
  await assert.rejects(f.ops.moveFile({ ...input, targetPath }), { code: 'MOVE_FAILED' });
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'racing target');
  assert.equal(await fs.readFile(input.path, 'utf8'), 'synthetic text\n');
});

test('move detects externally changed disk contents even when VS Code still caches the old document', async t => {
  const f = await fixture(t);
  const input = await f.write();
  await f.readForWorkspace(f.snapshot(f.state.id, 'edit'), input.path, 'edit');
  await fs.writeFile(input.path, 'externally changed');
  await assert.rejects(f.ops.moveFile({ ...input, targetPath: path.join(f.root, 'moved.txt') }), { code: 'EDIT_CONFLICT' });
  assert.deepEqual(f.calls.edits, []);
});

test('Trash requires a local modal and sends exactly the selected file with useTrash true', async t => {
  const f = await fixture(t);
  const input = await f.write();
  await f.write('neighbor.txt', 'keep neighbor');
  f.vscode.onWarning = async (...args) => args[2];
  const result = await f.ops.deleteFile(input);
  assert.deepEqual(result, { deleted: true, trashed: true, root: 0, path: 'source.txt' });
  assert.deepEqual(f.calls.deletes, [{ path: input.path, options: { useTrash: true, recursive: false } }]);
  assert.equal(f.calls.warnings[0][1].modal, true);
  assert.equal(f.calls.warnings[0][1].detail.includes('source.txt'), true);
  assert.equal(f.calls.warnings[0][1].detail.includes(f.root), false);
  assert.equal(await fs.readFile(path.join(f.trash, 'source.txt'), 'utf8'), 'synthetic text\n');
  assert.equal(await fs.readFile(path.join(f.root, 'neighbor.txt'), 'utf8'), 'keep neighbor');
  assert.equal(f.pendingApprovals.size, 0);
});

test('Trash denial is a no-op and Chinese approval remains local and explicit', async t => {
  const f = await fixture(t);
  const input = await f.write();
  f.vscode.env.language = 'zh-CN';
  await assert.rejects(f.ops.deleteFile(input), { code: 'APPROVAL_DENIED' });
  assert.equal(f.calls.warnings[0][2], '移到回收站');
  assert.deepEqual(f.calls.deletes, []);
  assert.equal(await fs.readFile(input.path, 'utf8'), 'synthetic text\n');
});

test('Trash has no permanent deletion fallback when the platform Trash call fails', async t => {
  const f = await fixture(t);
  const input = await f.write();
  f.vscode.onWarning = async (...args) => args[2];
  f.vscode.trashUnavailable = true;
  await assert.rejects(f.ops.deleteFile(input), { code: 'TRASH_FAILED' });
  assert.equal(f.calls.deletes.length, 1);
  assert.deepEqual(f.calls.deletes[0].options, { useTrash: true, recursive: false });
  assert.equal(await fs.readFile(input.path, 'utf8'), 'synthetic text\n');
});

test('Trash revalidates permission and workspace identity after a local user response', async t => {
  for (const change of [f => { f.state.access.edit = false; }, f => { f.state.id = 'new-session'; }]) {
    const f = await fixture(t);
    const input = await f.write();
    f.vscode.onWarning = async (...args) => { change(f); return args[2]; };
    await assert.rejects(f.ops.deleteFile(input), error => ['ACCESS_DENIED', 'WORKSPACE_CHANGED'].includes(error.code));
    assert.deepEqual(f.calls.deletes, []);
  }
});

test('Trash revalidates hash, dirty state, and document version after approval', async t => {
  for (const change of [
    async f => { await fs.writeFile(path.join(f.root, 'source.txt'), 'changed during approval'); },
    async f => { [...f.documents.values()][0].isDirty = true; },
    async f => { [...f.documents.values()][0].version++; },
  ]) {
    const f = await fixture(t);
    const input = await f.write();
    f.vscode.onWarning = async (...args) => { await change(f); return args[2]; };
    await assert.rejects(f.ops.deleteFile(input), error => ['EDIT_CONFLICT', 'UNSAVED_CHANGES'].includes(error.code));
    assert.deepEqual(f.calls.deletes, []);
  }
});

test('cancelled approval cannot delete a file even if the old modal is later accepted', async t => {
  const f = await fixture(t);
  const input = await f.write();
  const modal = deferred();
  const shown = deferred();
  f.vscode.onWarning = (...args) => { shown.resolve(args[2]); return modal.promise; };
  const operation = f.ops.deleteFile(input);
  const label = await shown.promise;
  assert.equal(f.pendingApprovals.size, 1);
  for (const cancel of f.pendingApprovals) cancel();
  await assert.rejects(operation, { code: 'APPROVAL_DENIED' });
  modal.resolve(label);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.deletes, []);
  assert.equal(f.pendingApprovals.size, 0);
});

test('Trash rejects a same-content replacement of the approved file', async t => {
  const f = await fixture(t);
  const input = await f.write();
  f.vscode.onWarning = async (...args) => {
    const replacement = path.join(f.root, 'replacement.txt');
    await fs.writeFile(replacement, 'synthetic text\n');
    await fs.unlink(input.path);
    await fs.rename(replacement, input.path);
    return args[2];
  };
  await assert.rejects(f.ops.deleteFile(input), { code: 'PATH_CHANGED' });
  assert.deepEqual(f.calls.deletes, []);
  assert.equal(await fs.readFile(input.path, 'utf8'), 'synthetic text\n');
});

test('move checks the actual live editor again after asynchronous target checks', async t => {
  const f = await fixture(t);
  const input = await f.write();
  const target = path.join(f.root, 'moved.txt');
  let targetChecks = 0;
  f.vscode.onChecked = async checked => {
    if (checked === target && ++targetChecks === 3) [...f.documents.values()][0].isDirty = true;
  };
  await assert.rejects(f.ops.moveFile({ ...input, targetPath: target }), { code: 'UNSAVED_CHANGES' });
  assert.deepEqual(f.calls.edits, []);
});

test('Trash approval expires after 30 seconds and late acceptance cannot delete the file', async t => {
  const f = await fixture(t);
  const input = await f.write();
  const modal = deferred();
  const shown = deferred();
  f.vscode.onWarning = (...args) => { shown.resolve(args[2]); return modal.promise; };
  const originalSetTimeout = global.setTimeout;
  let expire;
  // Only replace timer scheduling until the synthetic modal is presented.
  t.mock.method(global, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds === TRASH_APPROVAL_TIMEOUT_MS) { expire = callback; return { syntheticTimer: true }; }
    return originalSetTimeout(callback, milliseconds, ...args);
  });
  const operation = f.ops.deleteFile(input);
  const label = await shown.promise;
  assert.equal(TRASH_APPROVAL_TIMEOUT_MS, 30_000);
  assert.equal(typeof expire, 'function');
  expire();
  await assert.rejects(operation, { code: 'APPROVAL_DENIED' });
  modal.resolve(label);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.deletes, []);
  assert.equal(await fs.readFile(input.path, 'utf8'), 'synthetic text\n');
});

test('file lifecycle rejects directories, binary/oversized text, sensitive files, and missing hash', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'folder'));
  const safe = await f.write();
  await f.write('binary.txt', 'before\0after');
  await f.write('large.txt', 'x'.repeat(MAX_TEXT_BYTES + 1));
  await f.write('.env', 'excluded text');
  const cases = [
    { ...f.args('folder'), expectedHash: safe.expectedHash },
    { ...f.args('binary.txt'), expectedHash: security.hashText('before\0after') },
    { ...f.args('large.txt'), expectedHash: security.hashText('x'.repeat(MAX_TEXT_BYTES + 1)) },
    { ...f.args('.env'), expectedHash: security.hashText('excluded text') },
    f.args('source.txt'),
  ];
  for (const input of cases) {
    await assert.rejects(f.ops.deleteFile(input));
    await assert.rejects(f.ops.moveFile({ ...input, targetPath: path.join(f.root, 'target.txt') }));
  }
  assert.deepEqual(f.calls.deletes, []);
  assert.deepEqual(f.calls.edits, []);
  assert.deepEqual(f.calls.warnings, []);
});

test('directory links, file links and hard links are excluded from all lifecycle operations', async t => {
  const f = await fixture(t);
  const input = await f.write();
  await fs.mkdir(path.join(f.root, 'real-directory'));
  try { await fs.symlink(path.join(f.root, 'real-directory'), path.join(f.root, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('This environment cannot create directory links.'); throw error; }
  await assert.rejects(f.ops.createDirectory(f.args('linked-directory/new')), { code: 'SYMLINK_DENIED' });
  await assert.rejects(f.ops.moveFile({ ...input, targetPath: path.join(f.root, 'linked-directory/moved.txt') }), { code: 'SYMLINK_DENIED' });
  await fs.link(input.path, path.join(f.root, 'hard-link.txt'));
  await assert.rejects(f.ops.deleteFile(input), { code: 'HARDLINK_DENIED' });
  await assert.rejects(f.ops.moveFile({ ...input, targetPath: path.join(f.root, 'moved.txt') }), { code: 'HARDLINK_DENIED' });
  assert.deepEqual(f.calls.directories, []);
  assert.deepEqual(f.calls.deletes, []);
  assert.deepEqual(f.calls.edits, []);
});
