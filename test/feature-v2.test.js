'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const security = require('../src/security');
const { createVscodeHost } = require('../src/vscode-host');

async function fixture(t, text = 'const answer = 42;\n', hostOptions = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-features-')));
  const file = path.join(root, 'example.js');
  await fs.writeFile(file, text);
  class Uri {
    constructor(value, scheme = 'file') { this.fsPath = value; this.scheme = scheme; }
    static file(value) { return new Uri(value); }
    toString() { return `${this.scheme}:${this.fsPath}`; }
  }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  const range = (sl, sc, el, ec) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });
  function offsetAt(value, position) {
    const lines = value.split(/\r\n|\r|\n/);
    const endings = value.match(/\r\n|\r|\n/g) || [];
    return lines.slice(0, position.line).reduce((offset, line, i) => offset + line.length + endings[i].length, 0) + position.character;
  }
  const document = { uri: Uri.file(file), version: 1, languageId: 'javascript', isDirty: false, text,
    getText(selection) { return selection ? this.text.slice(offsetAt(this.text, selection.start), offsetAt(this.text, selection.end)) : this.text; } };
  const editor = { document, selection: range(0, 6, 0, 12) };
  editor.selections = [editor.selection];
  const commandCalls = [];
  const access = { read: true, edit: false, terminal: false };
  const hooks = {};
  const vscode = {
    Uri, Position, env: { language: 'en' },
    workspace: { isTrusted: true, name: 'Synthetic project', workspaceFolders: [{ name: 'fixture', uri: Uri.file(root) }], textDocuments: [document],
      registerTextDocumentContentProvider() { return { dispose() {} }; },
      async openTextDocument(uri) { assert.equal(uri.fsPath, file); return document; } },
    window: { activeTextEditor: editor, tabGroups: { all: [] } },
    commands: { async executeCommand(name, ...args) { commandCalls.push({ name, args }); return hooks.provider ? hooks.provider(name, ...args) : []; } },
  };
  const host = createVscodeHost({ ...hostOptions, vscode, getAccess: () => access, security: { ...security,
    async resolvePath(...args) { const resolved = await security.resolvePath(...args); if (hooks.resolve) await hooks.resolve(); return resolved; } } });
  t.after(async () => { host.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file, document, editor, vscode, host, hooks, access, range, commandCalls,
    args: () => ({ workspaceId: host.getWorkspace().id }) };
}

test('editor context returns relative metadata and a hash without pushing document or selection text', async t => {
  const f = await fixture(t);
  const result = await f.host.getEditorContext(f.args());
  assert.equal(result.active, true);
  assert.equal(result.path, 'example.js');
  assert.equal(result.root, 0);
  assert.equal(result.hash, security.hashText(f.document.text));
  assert.deepEqual(result.selection, f.range(0, 6, 0, 12));
  assert.equal(result.selectionCount, 1);
  assert.equal(result.languageId, 'javascript');
  assert.equal(Object.hasOwn(result, 'selectedText'), false);
  assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(JSON.stringify(result).includes('const answer'), false);
});

test('editor context exposes only the explicitly requested primary selection with CRLF and UTF-16 positions', async t => {
  const f = await fixture(t, '😀answer\r\nnext line\r\n');
  f.editor.selection = f.range(0, 2, 1, 4);
  f.editor.selections = [f.editor.selection, f.range(1, 5, 1, 9)];
  const result = await f.host.getEditorContext({ ...f.args(), includeSelection: true });
  assert.equal(result.selectedText, 'answer\r\nnext');
  assert.equal(result.selectionTruncated, false);
  assert.equal(result.selectionCount, 2);
  assert.equal(result.selections.length, 2);
  assert.equal(result.selectedText.includes('line'), false);
});

test('editor context bounds selection text and selection ranges', async t => {
  const f = await fixture(t, 'x'.repeat(9000));
  f.editor.selection = f.range(0, 0, 0, 9000);
  f.editor.selections = Array.from({ length: 30 }, () => f.editor.selection);
  const result = await f.host.getEditorContext({ ...f.args(), includeSelection: true });
  assert.equal(result.selectedText.length, 8000);
  assert.equal(result.selectionTruncated, true);
  assert.equal(result.selections.length, 20);
  assert.equal(result.selectionCount, 30);
  assert.equal(result.selectionRangesTruncated, true);
});

test('editor context never broadens the captured selection when the user moves it during path checks', async t => {
  const f = await fixture(t);
  f.hooks.resolve = () => { f.editor.selection = f.range(0, 0, 1, 0); };
  const result = await f.host.getEditorContext({ ...f.args(), includeSelection: true });
  assert.equal(result.selectedText, 'answer');
  assert.deepEqual(result.selection, f.range(0, 6, 0, 12));
});

test('editor context never serializes untitled, external, or sensitive active editors', async t => {
  const f = await fixture(t);
  for (const uri of [new f.vscode.Uri('Untitled-1', 'untitled'), f.vscode.Uri.file(path.join(path.dirname(f.root), 'outside.txt')),
    f.vscode.Uri.file(path.join(f.root, '.env'))]) {
    f.vscode.window.activeTextEditor = { document: { uri, getText() { throw new Error('Unsafe editor must not be read.'); } } };
    assert.deepEqual(await f.host.getEditorContext(f.args()), { active: false });
  }
  f.vscode.window.activeTextEditor = undefined;
  assert.deepEqual(await f.host.getEditorContext(f.args()), { active: false });
});

test('editor context scans complete content before truncation and rejects oversized live buffers', async t => {
  const f = await fixture(t, 'x'.repeat(9000));
  f.document.text += '\n' + ['gh', 'p_', 'a'.repeat(36)].join('');
  f.editor.selection = f.range(0, 0, 1, 40);
  await assert.rejects(f.host.getEditorContext({ ...f.args(), includeSelection: true }), { code: 'SENSITIVE_CONTENT' });
  f.document.text = 'x'.repeat(512 * 1024 + 1);
  await assert.rejects(f.host.getEditorContext(f.args()), { code: 'FILE_TOO_LARGE' });
});

test('editor context rejects an editor, version, session, or access change during the request', async t => {
  for (const change of ['editor', 'version', 'session', 'access']) {
    const f = await fixture(t);
    const args = f.args();
    let changed = false;
    f.hooks.resolve = () => {
      if (changed) return;
      changed = true;
      if (change === 'editor') f.vscode.window.activeTextEditor = { ...f.editor };
      if (change === 'version') f.document.version++;
      if (change === 'session') f.host.resetSession();
      if (change === 'access') f.access.read = false;
    };
    await assert.rejects(f.host.getEditorContext(args), { code: { editor: 'EDITOR_CHANGED', version: 'EDITOR_CHANGED', session: 'WORKSPACE_CHANGED', access: 'ACCESS_DENIED' }[change] });
  }
});

test('hover uses the fixed language provider and serializes only bounded text and relative-safe ranges', async t => {
  const f = await fixture(t);
  f.hooks.provider = () => [{ contents: ['number', { value: `Defined in ${f.file}`, isTrusted: true, baseUri: 'private-metadata' }, { language: 'javascript', value: 'const answer: 42' }], range: f.range(0, 6, 0, 12) }];
  const result = await f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 7 });
  assert.equal(f.commandCalls.length, 1);
  assert.equal(f.commandCalls[0].name, 'vscode.executeHoverProvider');
  assert.equal(f.commandCalls[0].args[1].line, 0);
  assert.equal(f.commandCalls[0].args[1].character, 7);
  assert.equal(result.untrusted, true);
  assert.equal(result.truncated, false);
  assert.equal(result.hovers[0].contents[0], 'number');
  assert.deepEqual(result.hovers[0].range, f.range(0, 6, 0, 12));
  assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(JSON.stringify(result).includes('baseUri'), false);
  assert.equal(JSON.stringify(result).includes('private-metadata'), false);
});

test('hover rejects negative, fractional, nonexistent, or beyond-line positions before calling a provider', async t => {
  const f = await fixture(t, '😀answer\r\nnext');
  for (const [line, character] of [[-1, 0], [0, -1], [0, 1.5], [2, 0], [0, 9], [1, 5]]) {
    await assert.rejects(f.host.getHover({ ...f.args(), path: f.file, line, character }), { code: 'INVALID_POSITION' });
  }
  assert.equal(f.commandCalls.length, 0);
  await f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 8 });
  assert.equal(f.commandCalls.length, 1, 'UTF-16 positions at the actual line end are accepted.');
});

test('hover returns an empty result when no information is available without claiming provider support', async t => {
  const f = await fixture(t);
  f.hooks.provider = () => undefined;
  const result = await f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 });
  assert.deepEqual(result, { hovers: [], truncated: false, untrusted: true });
  assert.equal(Object.hasOwn(result, 'providerAvailable'), false);
});

test('hover caps provider results and text while scanning a complete value before truncation', async t => {
  const f = await fixture(t);
  f.hooks.provider = () => Array.from({ length: 6 }, () => ({ contents: [{ value: 'x'.repeat(15000) }] }));
  const result = await f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 });
  assert.equal(result.hovers.length, 5);
  assert.equal(result.hovers.flatMap(item => item.contents).join('').length, 12000);
  assert.equal(result.truncated, true);
  f.hooks.provider = () => [{ contents: [{ value: 'x'.repeat(13000) + '\n' + ['gh', 'p_', 'a'.repeat(36)].join('') }] }];
  await assert.rejects(f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'SENSITIVE_CONTENT' });
});

test('hover rejects excessive provider source text before processing an unbounded Markdown response', async t => {
  const f = await fixture(t);
  f.hooks.provider = () => [{ contents: [{ value: 'x'.repeat(128001) }] }];
  await assert.rejects(f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'RESULT_TOO_LARGE' });
  f.hooks.provider = () => [{ contents: [{ value: 'x'.repeat(70000) }, { value: 'x'.repeat(70000) }] }];
  await assert.rejects(f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'RESULT_TOO_LARGE' });
});

test('hover rejects denied files and secrets before a provider and rechecks session and access after it', async t => {
  const f = await fixture(t);
  await assert.rejects(f.host.getHover({ ...f.args(), path: path.join(f.root, '.env'), line: 0, character: 0 }), { code: 'OUTSIDE_WORKSPACE' });
  f.document.text = ['gh', 'p_', 'b'.repeat(36)].join('');
  await assert.rejects(f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'SENSITIVE_CONTENT' });
  assert.equal(f.commandCalls.length, 0);
  f.document.text = 'safe';
  f.hooks.provider = () => { f.host.resetSession(); return [{ contents: ['safe'] }]; };
  await assert.rejects(f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'WORKSPACE_CHANGED' });
  f.hooks.provider = () => { f.access.read = false; return [{ contents: ['safe'] }]; };
  await assert.rejects(f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'ACCESS_DENIED' });
});

test('hover times out a stalled provider without leaking late failures or blocking subsequent requests', async t => {
  const f = await fixture(t, 'const answer = 42;\n', { languageTimeoutMs: 20 });
  let rejectLate;
  f.hooks.provider = () => new Promise((_, reject) => { rejectLate = reject; });
  await assert.rejects(f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'LANGUAGE_TIMEOUT' });
  rejectLate(new Error('A late provider failure must already have a rejection handler.'));
  await new Promise(resolve => setImmediate(resolve));
  f.hooks.provider = () => [{ contents: ['Ready after loading.'] }];
  const result = await f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 });
  assert.equal(result.hovers[0].contents[0], 'Ready after loading.');
});

test('hover refuses results after the live document version changes while its provider runs', async t => {
  const f = await fixture(t);
  f.hooks.provider = () => { f.document.version++; return [{ contents: ['Stale hover.'] }]; };
  await assert.rejects(f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'DOCUMENT_CHANGED' });
});

test('hover ignores malformed provider ranges instead of serializing arbitrary provider metadata', async t => {
  const f = await fixture(t);
  f.hooks.provider = () => [{ contents: ['Safe text.'], range: { start: { line: -1, character: 0 } } },
    { contents: ['More text.'], range: f.range(100, 0, 101, 1) }];
  const result = await f.host.getHover({ ...f.args(), path: f.file, line: 0, character: 0 });
  assert.deepEqual(result.hovers, [{ contents: ['Safe text.'] }, { contents: ['More text.'] }]);
});
