'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const security = require('../src/security');
const { applyTextEdits } = require('../src/text-edits');
const { createRefactorOps, PLAN_TTL_MS } = require('../src/refactor-ops');
const { definitions } = require('../src/refactor-tools');

async function fixture(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-refactor-')));
  const root = path.join(base, 'workspace');
  await fs.mkdir(root);
  const state = { id: 'synthetic-refactor', read: true, refactor: true, trusted: true, timeOffset: 0 };
  const documents = new Map();
  const listeners = new Set();
  const pendingApprovals = new Set();
  const calls = { providers: [], previews: [], applied: [], saves: 0, warnings: [] };
  const locks = new Map();
  const fail = (code, message) => { throw new security.BridgeError(code, message); };
  class Uri {
    constructor(value, scheme = 'file') { this.fsPath = path.resolve(value); this.scheme = scheme; }
    static file(value) { return new Uri(value); }
    toString() { return `${this.scheme}:${this.fsPath}`; }
  }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range {
    constructor(a, b, c, d) {
      this.start = typeof a === 'number' ? new Position(a, b) : a;
      this.end = typeof a === 'number' ? new Position(c, d) : b;
    }
  }
  class WorkspaceEdit {
    constructor() { this.values = []; }
    replace(uri, editRange, newText) { this.values.push({ _type: 2, uri, edit: { range: editRange, newText } }); }
    renameFile(from, to) { this.values.push({ _type: 1, from, to }); }
    _allEntries() { return this.values; }
  }
  const vscode = { Uri, Position, Range, WorkspaceEdit, env: { language: 'en' },
    commands: { async executeCommand(command, ...args) { calls.providers.push({ command, args }); return vscode.provide?.(command, ...args); } },
    workspace: {
      onDidChangeTextDocument(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
      async openTextDocument(uri) {
        const id = uri.toString();
        if (!documents.has(id)) {
          const doc = { uri, text: await fs.readFile(uri.fsPath, 'utf8'), version: 1, isDirty: false,
            getText() { return this.text; }, async save() { calls.saves++; await fs.writeFile(uri.fsPath, this.text); this.isDirty = false; return true; } };
          documents.set(id, doc);
        }
        return documents.get(id);
      },
      async applyEdit(edit) {
        calls.applied.push(edit);
        if (vscode.beforeApply) await vscode.beforeApply(edit);
        if (vscode.rejectApply) return false;
        const groups = new Map();
        for (const entry of edit._allEntries()) {
          assert.equal(entry._type, 2);
          if (!groups.has(entry.uri.toString())) groups.set(entry.uri.toString(), []);
          groups.get(entry.uri.toString()).push({ range: entry.edit.range, text: entry.edit.newText });
        }
        for (const [id, edits] of groups) {
          const document = documents.get(id);
          document.text = applyTextEdits(document.text, edits);
          document.version++;
          document.isDirty = true;
          for (const listener of listeners) listener({ document });
        }
        return true;
      },
    },
    window: { async showWarningMessage(...args) { calls.warnings.push(args); return vscode.approve ? vscode.approve(...args) : args.at(-1); } },
  };
  const getWorkspace = () => ({ id: state.id, trusted: state.trusted, roots: [{ path: root, name: 'Synthetic' }] });
  const recheck = (workspace, capability = 'read') => {
    if (workspace.id !== state.id) fail('WORKSPACE_CHANGED', 'Workspace changed.');
    if (!state.trusted || state[capability] !== true) fail('ACCESS_DENIED', 'Access revoked.');
  };
  const snapshot = (id, capability = 'read') => {
    if (id !== state.id) fail('WORKSPACE_CHANGED', 'Workspace changed.');
    const workspace = getWorkspace(); recheck(workspace, capability); return workspace;
  };
  const checkedPath = async (workspace, absolute, settings = {}) => {
    const relative = security.toRelative(workspace, absolute);
    if (!relative) fail('OUTSIDE_WORKSPACE', 'Outside/excluded path.');
    const result = await security.resolvePath(workspace, relative.path, { root: relative.root });
    recheck(workspace, settings.capability);
    return result;
  };
  const readForWorkspace = async (workspace, absolute, capability) => {
    const canonical = await checkedPath(workspace, absolute, { capability });
    const doc = await vscode.workspace.openTextDocument(Uri.file(canonical));
    security.assertSafeContent(doc.text);
    return { text: doc.text, version: doc.version, isDirty: doc.isDirty };
  };
  const withFileLock = async (absolute, operation) => {
    const normalized = absolute.toLowerCase();
    const previous = locks.get(normalized) || Promise.resolve();
    let release; const mine = new Promise(resolve => { release = resolve; });
    locks.set(normalized, mine); await previous;
    try { return await operation(); } finally { release(); if (locks.get(normalized) === mine) locks.delete(normalized); }
  };
  const ops = createRefactorOps({ vscode, snapshot, checkedPath, readForWorkspace, recheck, withFileLock,
    relativeInput: security.toRelative, toRelative: security.toRelative, hashText: security.hashText,
    assertSafeContent: security.assertSafeContent, pendingApprovals, fail,
    previewDiff: async input => { calls.previews.push(input); if (vscode.onPreview) await vscode.onPreview(input); },
    now: () => Date.now() + state.timeOffset, ...options });
  t.after(async () => {
    for (const cancel of pendingApprovals) cancel();
    assert.equal(path.basename(base).startsWith('bridge-refactor-'), true);
    await fs.rm(base, { recursive: true, force: true });
  });
  const write = async (name, text) => {
    await fs.writeFile(path.join(root, name), text);
    return { workspaceId: state.id, path: path.join(root, name), expectedHash: security.hashText(text), line: 0, character: 13, newName: 'total' };
  };
  const rename = async () => {
    const input = await write('source.js', 'export const count = 1;\n');
    await write('usage.js', 'console.log(count);\n');
    vscode.provide = () => {
      const edit = new WorkspaceEdit();
      edit.replace(Uri.file(input.path), new Range(0, 13, 0, 18), 'total');
      edit.replace(Uri.file(path.join(root, 'usage.js')), new Range(0, 12, 0, 17), 'total');
      return edit;
    };
    return input;
  };
  const document = name => vscode.workspace.openTextDocument(Uri.file(path.join(root, name)));
  return { ops, base, root, vscode, state, calls, documents, write, rename, document, listeners };
}

test('semantic rename previews every file, applies once, and preserves all unsaved buffers without disk writes', async t => {
  const f = await fixture(t);
  const input = await f.rename();
  const usage = await f.document('usage.js');
  usage.text += '// existing unsaved work\n'; usage.version++; usage.isDirty = true;
  const prepared = await f.ops.prepareRename(input);
  assert.equal(prepared.fileCount, 2);
  assert.equal(prepared.previewed, true);
  assert.equal(f.calls.previews.length, 2);
  assert.equal(f.calls.applied.length, 0);
  assert.equal(JSON.stringify(prepared).includes(f.root), false);
  assert.equal(f.calls.providers[0].command, 'vscode.executeDocumentRenameProvider');
  const result = await f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: prepared.refactorId });
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.equal(result.saved, false);
  assert.equal(result.requiresSave, true);
  assert.equal(f.calls.applied.length, 1);
  assert.equal(f.calls.saves, 0);
  assert.equal((await f.document('source.js')).text, 'export const total = 1;\n');
  assert.equal(usage.text, 'console.log(total);\n// existing unsaved work\n');
  assert.equal(result.files.find(file => file.path === 'usage.js').wasDirty, true);
  assert.equal(await fs.readFile(input.path, 'utf8'), 'export const count = 1;\n');
  assert.equal(await fs.readFile(path.join(f.root, 'usage.js'), 'utf8'), 'console.log(count);\n');
});

test('cross-file buffer conflict rejects the whole batch before any apply', async t => {
  const f = await fixture(t); const input = await f.rename();
  const prepared = await f.ops.prepareRename(input);
  const usage = await f.document('usage.js'); usage.text = '// locally changed\n'; usage.version++;
  await assert.rejects(f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: prepared.refactorId }), { code: 'EDIT_CONFLICT' });
  assert.equal(f.calls.applied.length, 0);
  assert.equal((await f.document('source.js')).text, 'export const count = 1;\n');
});

test('external disk change conflicts even if an already-open buffer is unchanged', async t => {
  const f = await fixture(t); const input = await f.rename();
  const prepared = await f.ops.prepareRename(input);
  await fs.writeFile(path.join(f.root, 'usage.js'), 'console.log(other);\n');
  await assert.rejects(f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: prepared.refactorId }), { code: 'EDIT_CONFLICT' });
  assert.equal(f.calls.applied.length, 0);
});

test('byte-only BOM changes and buffer version changes invalidate an otherwise identical preview', async t => {
  const f = await fixture(t); const input = await f.rename();
  let prepared = await f.ops.prepareRename(input);
  await fs.writeFile(path.join(f.root, 'usage.js'), '\ufeffconsole.log(count);\n');
  await assert.rejects(f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: prepared.refactorId }), { code: 'EDIT_CONFLICT' });
  await fs.writeFile(path.join(f.root, 'usage.js'), 'console.log(count);\n');
  prepared = await f.ops.prepareRename(input);
  (await f.document('usage.js')).version++;
  await assert.rejects(f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: prepared.refactorId }), { code: 'EDIT_CONFLICT' });
  assert.equal(f.calls.applied.length, 0);
});

test('resource operations cannot hide behind ordinary text edits', async t => {
  const f = await fixture(t); const input = await f.rename();
  const prior = f.vscode.provide;
  f.vscode.provide = () => { const edit = prior(); edit.renameFile(f.vscode.Uri.file(input.path), f.vscode.Uri.file(path.join(f.root, 'renamed.js'))); return edit; };
  await assert.rejects(f.ops.prepareRename(input), { code: 'UNSAFE_WORKSPACE_EDIT' });
  assert.equal(f.calls.previews.length, 0);
  assert.equal(f.calls.applied.length, 0);
});

test('outside files and sensitive provider replacement text are rejected before preview', async t => {
  const f = await fixture(t); const input = await f.rename();
  const outside = path.join(f.base, 'outside.js'); await fs.writeFile(outside, 'count');
  f.vscode.provide = () => { const edit = new f.vscode.WorkspaceEdit(); edit.replace(f.vscode.Uri.file(outside), new f.vscode.Range(0, 0, 0, 5), 'total'); return edit; };
  await assert.rejects(f.ops.prepareRename(input), { code: 'OUTSIDE_WORKSPACE' });
  f.vscode.provide = () => { const edit = new f.vscode.WorkspaceEdit(); edit.replace(f.vscode.Uri.file(input.path), new f.vscode.Range(0, 0, 0, 0), `password = '${'x'.repeat(24)}'\n`); return edit; };
  await assert.rejects(f.ops.prepareRename(input), { code: 'SENSITIVE_CONTENT' });
  assert.equal(f.calls.previews.length, 0);
});

test('unknown WorkspaceEdit representations fail closed', async t => {
  const f = await fixture(t); const input = await f.rename();
  f.vscode.provide = () => ({ entries: () => [], size: 0 });
  await assert.rejects(f.ops.prepareRename(input), { code: 'UNSUPPORTED_WORKSPACE_EDIT' });
});

test('code actions with commands are excluded while safe edit-only actions can be previewed', async t => {
  const f = await fixture(t); const input = await f.rename(); const prior = f.vscode.provide;
  f.vscode.provide = () => [
    { title: 'Dangerous command', edit: prior(), command: { command: 'arbitrary.run' } },
    { title: 'Edit only fix', edit: prior(), kind: { value: 'quickfix' } },
  ];
  const listed = await f.ops.getCodeActions(input);
  assert.equal(listed.actions.length, 1);
  assert.equal(listed.excludedActions, 1);
  assert.equal(listed.actions[0].title, 'Edit only fix');
  assert.equal(f.calls.previews.length, 0);
  assert.equal(f.calls.providers.length, 1);
  assert.equal(f.calls.providers[0].command, 'vscode.executeCodeActionProvider');
  const prepared = await f.ops.prepareCodeAction({ workspaceId: input.workspaceId, actionId: listed.actions[0].actionId });
  assert.equal(prepared.fileCount, 2);
  assert.equal(f.calls.previews.length, 2);
});

test('action titles are untrusted text with local root paths redacted', async t => {
  const f = await fixture(t); const input = await f.rename(); const prior = f.vscode.provide;
  f.vscode.provide = () => [{ title: `Fix ${f.root}\nentry`, edit: prior() }];
  const result = await f.ops.getCodeActions(input);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].title, 'Fix [workspace] entry');
  assert.equal(JSON.stringify(result).includes(f.root), false);
});

test('multi-file scope limits reject the provider proposal before opening any preview', async t => {
  const f = await fixture(t); const input = await f.rename();
  for (let index = 0; index < 21; index++) await f.write(`scope-${index}.txt`, 'count\n');
  f.vscode.provide = () => {
    const edit = new f.vscode.WorkspaceEdit();
    for (let index = 0; index < 21; index++) edit.replace(f.vscode.Uri.file(path.join(f.root, `scope-${index}.txt`)), new f.vscode.Range(0, 0, 0, 5), 'total');
    return edit;
  };
  await assert.rejects(f.ops.prepareRename(input), { code: 'REFACTOR_TOO_LARGE' });
  assert.equal(f.calls.previews.length, 0);
});

test('permission revocation during approval prevents application', async t => {
  const f = await fixture(t); const input = await f.rename(); const prepared = await f.ops.prepareRename(input);
  f.vscode.approve = (...args) => { f.state.refactor = false; return args.at(-1); };
  await assert.rejects(f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: prepared.refactorId }), { code: 'ACCESS_DENIED' });
  assert.equal(f.calls.applied.length, 0);
});

test('concurrent requests cannot reuse the same preview token or apply overlapping stale plans', async t => {
  const f = await fixture(t); const input = await f.rename();
  const first = await f.ops.prepareRename(input);
  const second = await f.ops.prepareRename(input);
  const results = await Promise.allSettled([
    f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: first.refactorId }),
    f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: first.refactorId }),
    f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: second.refactorId }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.some(result => result.status === 'rejected' && result.reason.code === 'REFACTOR_EXPIRED'), true);
  assert.equal(results.some(result => result.status === 'rejected' && result.reason.code === 'EDIT_CONFLICT'), true);
  assert.equal(f.calls.applied.length, 1);
});

test('expired previews, cleared plans and changed workspace identity cannot apply', async t => {
  const f = await fixture(t); const input = await f.rename();
  let prepared = await f.ops.prepareRename(input);
  f.state.timeOffset += PLAN_TTL_MS + 10;
  await assert.rejects(f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: prepared.refactorId }), { code: 'REFACTOR_EXPIRED' });
  f.state.timeOffset = 0;
  prepared = await f.ops.prepareRename(input); f.ops.clearRefactorPlans();
  await assert.rejects(f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: prepared.refactorId }), { code: 'REFACTOR_EXPIRED' });
  prepared = await f.ops.prepareRename(input); f.state.id = 'new-session';
  await assert.rejects(f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: prepared.refactorId }), { code: 'WORKSPACE_CHANGED' });
});

test('local denial and approval timeout leave all files unchanged', async t => {
  const f = await fixture(t, { approvalTimeoutMs: 10 }); const input = await f.rename();
  let prepared = await f.ops.prepareRename(input); f.vscode.approve = () => undefined;
  await assert.rejects(f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: prepared.refactorId }), { code: 'APPROVAL_DENIED' });
  prepared = await f.ops.prepareRename(input); f.vscode.approve = () => new Promise(() => {});
  await assert.rejects(f.ops.applyRefactor({ workspaceId: input.workspaceId, refactorId: prepared.refactorId }), { code: 'APPROVAL_DENIED' });
  assert.equal(f.calls.applied.length, 0);
});

test('formatting is preview-only until application and uses fixed language-service command', async t => {
  const f = await fixture(t); const input = await f.write('format.js', 'const x=1;\n');
  f.vscode.provide = () => [{ range: new f.vscode.Range(0, 0, 0, 10), newText: 'const x = 1;' }];
  const prepared = await f.ops.formatDocument({ ...input, tabSize: 4, insertSpaces: true });
  assert.equal(prepared.fileCount, 1);
  assert.equal(f.calls.applied.length, 0);
  assert.equal(f.calls.previews[0].text, 'const x = 1;\n');
  assert.equal(f.calls.providers[0].command, 'vscode.executeFormatDocumentProvider');
});

test('provider timeout and document changes during provider execution return no plan', async t => {
  const f = await fixture(t, { languageTimeoutMs: 10 }); const input = await f.rename();
  f.vscode.provide = () => new Promise(() => {});
  await assert.rejects(f.ops.prepareRename(input), { code: 'LANGUAGE_TIMEOUT' });
  f.vscode.provide = async () => { const doc = await f.document('source.js'); doc.version++; for (const listener of f.listeners) listener({ document: doc }); return new f.vscode.WorkspaceEdit(); };
  await assert.rejects(f.ops.prepareRename(input), { code: 'EDIT_CONFLICT' });
  assert.equal(f.calls.previews.length, 0);
});

test('tool schemas keep rename, formatting and action application in refactor capability', () => {
  assert.equal(definitions.length, 5);
  assert.equal(definitions.every(definition => definition.capability === 'refactor'), true);
  assert.equal(definitions.find(definition => definition.name === 'prepare_rename').schema.safeParse({ workspaceId: 'test', path: 'src/a.js', line: 0, character: 0, newName: 'renamed' }).success, false);
  assert.equal(definitions.find(definition => definition.name === 'apply_refactor').schema.safeParse({ workspaceId: 'test', refactorId: 'a'.repeat(32), command: 'arbitrary.command' }).success, false);
});
