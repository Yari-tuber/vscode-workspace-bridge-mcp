'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const Module = require('node:module');
const { createVscodeHost, safeEnvironment } = require('../src/vscode-host');
const { hashText } = require('../src/security');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function mockVscode(root) {
  const documents = new Map();
  const commands = new Map();
  const commandCalls = [];
  const warningCalls = [];
  const infoCalls = [];
  const listeners = {};
  const noopDisposable = () => ({ dispose() {} });
  class Uri {
    constructor(scheme, value) { this.scheme = scheme; this.fsPath = scheme === 'file' ? path.resolve(value) : value; }
    static file(value) { return new Uri('file', value); }
    static parse(value) { const colon = value.indexOf(':'); return new Uri(value.slice(0, colon), value.slice(colon + 1)); }
    toString() { return `${this.scheme}:${this.fsPath}`; }
  }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range {
    constructor(start, end, endLine, endCharacter) {
      this.start = typeof start === 'number' ? new Position(start, end) : start;
      this.end = typeof start === 'number' ? new Position(endLine, endCharacter) : end;
    }
  }
  class WorkspaceEdit {
    constructor() { this.operations = []; }
    createFile(uri, options) { this.operations.push({ type: 'create', uri, options }); }
    replace(uri, range, text) { this.operations.push({ type: 'replace', uri, text }); }
    insert(uri, position, text) { this.operations.push({ type: 'insert', uri, text }); }
  }
  class EventEmitter {
    constructor() { this.event = () => noopDisposable(); }
    fire() {}
    dispose() {}
  }
  const api = {
    Uri, Position, Range, WorkspaceEdit, EventEmitter,
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id) { this.id = id; } }, ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, StatusBarAlignment: { Left: 1 },
    env: { language: 'en', clipboard: { async writeText(text) { api.clipboard = text; } } },
    workspace: {
      name: 'Demo workspace', isTrusted: true, workspaceFolders: [{ name: 'Demo', uri: Uri.file(root) }], textDocuments: [],
      registerTextDocumentContentProvider(scheme, provider) { api.contentProvider = { scheme, provider }; return noopDisposable(); },
      getConfiguration() { return { get: (key, fallback) => Object.hasOwn(api.settings, key) ? api.settings[key] : fallback }; },
      onDidChangeWorkspaceFolders(callback) { listeners.folders = callback; return noopDisposable(); },
      onDidGrantWorkspaceTrust(callback) { listeners.trust = callback; return noopDisposable(); },
      onDidChangeConfiguration(callback) { listeners.configuration = callback; return noopDisposable(); },
      async openTextDocument(uri) {
        const key = uri.toString();
        if (!documents.has(key)) {
          const initial = await fs.readFile(uri.fsPath, 'utf8');
          const document = {
            uri, text: initial, version: 1, languageId: 'plaintext', isDirty: false,
            getText() { return this.text; }, positionAt(offset) { return new Position(0, offset); },
            async save() { await fs.writeFile(uri.fsPath, this.text); this.isDirty = false; return true; },
          };
          documents.set(key, document);
          api.workspace.textDocuments.push(document);
        }
        return documents.get(key);
      },
      async applyEdit(edit) {
        api.appliedEdits++;
        for (const operation of edit.operations) {
          if (operation.type === 'create') {
            try { await fs.writeFile(operation.uri.fsPath, '', { flag: 'wx' }); } catch { return false; }
          } else {
            const document = await api.workspace.openTextDocument(operation.uri);
            document.text = operation.text; document.version++; document.isDirty = true;
          }
        }
        return true;
      },
      fs: { writeFile: (uri, buffer) => fs.writeFile(uri.fsPath, buffer) },
    },
    commands: {
      registerCommand(name, callback) { commands.set(name, callback); return { dispose() { commands.delete(name); } }; },
      async executeCommand(name, ...args) {
        commandCalls.push({ name, args });
        if (commands.has(name)) return commands.get(name)(...args);
        return api.languageResults[name] || [];
      },
    },
    window: {
      createStatusBarItem() { return { ...noopDisposable(), show() {} }; },
      createTreeView(id, options) { api.treeProvider = options.treeDataProvider; return noopDisposable(); },
      async showWarningMessage(...args) { warningCalls.push(args); return api.warningResponse ? api.warningResponse(...args) : undefined; },
      async showInformationMessage(...args) { infoCalls.push(args); },
      async showErrorMessage(...args) { api.errorCalls.push(args); },
      async showQuickPick(...args) { return api.quickPickResponse ? api.quickPickResponse(...args) : undefined; },
      async showSaveDialog() { return undefined; },
      async showTextDocument() {},
      tabGroups: { all: [], async close() { return true; } },
    },
    languages: { getDiagnostics(uri) { return uri ? (api.diagnostics.get(uri.toString()) || []) : [...api.diagnostics].map(([key, entries]) => [Uri.parse(key), entries]); } },
    settings: {}, appliedEdits: 0, languageResults: {}, diagnostics: new Map(), commandsMap: commands,
    commandCalls, warningCalls, infoCalls, errorCalls: [], listeners,
  };
  return api;
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-host-')));
  const vscode = mockVscode(root);
  const access = { read: true, edit: false, terminal: false };
  const host = createVscodeHost({ vscode, getAccess: () => access, approvalTimeoutMs: 20 });
  t.after(async () => { host.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, vscode, access, host, args: () => ({ workspaceId: host.getWorkspace().id }) };
}

test('host requires the live workspace id and strict boolean access', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'code.txt'), 'hello');
  await assert.rejects(f.host.readDocument({ path: path.join(f.root, 'code.txt') }), { code: 'WORKSPACE_REQUIRED' });
  const stale = f.args();
  f.host.resetSession();
  await assert.rejects(f.host.readDocument({ ...stale, path: path.join(f.root, 'code.txt') }), { code: 'WORKSPACE_CHANGED' });
  f.access.read = 'true';
  assert.equal(f.host.getAccess().read, false);
  await assert.rejects(f.host.readDocument({ ...f.args(), path: path.join(f.root, 'code.txt') }), { code: 'ACCESS_DENIED' });
});

test('host protects credential files and editor buffers', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '.env'), 'example=hidden');
  await assert.rejects(f.host.readDocument({ ...f.args(), path: path.join(f.root, '.env') }), { code: 'OUTSIDE_WORKSPACE' });
  await fs.writeFile(path.join(f.root, 'code.txt'), 'const value = 1;');
  const result = await f.host.readDocument({ ...f.args(), path: path.join(f.root, 'code.txt') });
  assert.equal(result.text, 'const value = 1;');
  assert.equal(result.version, 1);
});

test('workspace root aliases bind to one canonical directory for the entire session', async t => {
  const f = await fixture(t);
  const original = path.join(f.root, 'original-root');
  const replacement = path.join(f.root, 'replacement-root');
  const alias = path.join(f.root, 'workspace-alias');
  await fs.mkdir(original);
  await fs.mkdir(replacement);
  await fs.writeFile(path.join(original, 'public.txt'), 'original root');
  await fs.writeFile(path.join(replacement, 'public.txt'), 'replacement root');
  try { await fs.symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('This environment cannot create directory aliases.');
    throw error;
  }
  const vscode = mockVscode(alias);
  const host = createVscodeHost({ vscode, getAccess: () => ({ read: true }) });
  t.after(() => host.dispose());
  const workspace = host.getWorkspace();
  assert.equal(workspace.roots[0].path, await fs.realpath(original));
  assert.equal(workspace.trusted, true);
  assert.equal((await host.readDocument({ workspaceId: workspace.id, path: path.join(workspace.roots[0].path, 'public.txt') })).text, 'original root');
  assert.equal((await host.readDocument({ workspaceId: workspace.id, path: path.join(alias, 'public.txt') })).text, 'original root');
  await fs.unlink(alias);
  await fs.symlink(replacement, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(host.getWorkspace().trusted, false);
  assert.equal(host.getWorkspace().roots[0].path, workspace.roots[0].path);
  await assert.rejects(host.readDocument({ workspaceId: workspace.id, path: path.join(workspace.roots[0].path, 'public.txt') }), { code: 'UNTRUSTED_WORKSPACE' });
  host.resetSession();
  const next = host.getWorkspace();
  assert.notEqual(next.id, workspace.id);
  assert.equal(next.trusted, true);
  assert.equal(next.roots[0].path, await fs.realpath(replacement));
});

test('new files use non-overwriting editor creation and existing edits recheck hashes', async t => {
  const f = await fixture(t);
  f.access.edit = true;
  const file = path.join(f.root, 'new.txt');
  const created = await f.host.applyEdit({ ...f.args(), path: file, text: 'first', expectedHash: 'new' });
  assert.equal(created.saved, true);
  assert.equal(created.hash, hashText('first'));
  assert.equal(created.eol, 'LF');
  assert.equal(await fs.readFile(file, 'utf8'), 'first');
  await assert.rejects(f.host.applyEdit({ ...f.args(), path: file, text: 'overwritten', expectedHash: 'new' }), { code: 'FILE_EXISTS' });
  const before = f.vscode.appliedEdits;
  await assert.rejects(f.host.applyEdit({ ...f.args(), path: file, text: 'wrong', expectedHash: hashText('outdated'), expectedVersion: created.version }), { code: 'EDIT_CONFLICT' });
  assert.equal(f.vscode.appliedEdits, before);
  await f.host.applyEdit({ ...f.args(), path: file, text: 'second', expectedHash: hashText('first'), expectedVersion: created.version });
  assert.equal(await fs.readFile(file, 'utf8'), 'second');
});

test('saved edit reports the actual editor hash and line ending after normalization', async t => {
  const f = await fixture(t);
  f.access.edit = true;
  const originalOpen = f.vscode.workspace.openTextDocument;
  f.vscode.workspace.openTextDocument = async uri => {
    const document = await originalOpen(uri);
    if (!document.normalizingSave) {
      const save = document.save.bind(document);
      document.normalizingSave = true;
      document.save = async () => { document.text = document.text.replace(/\r?\n/g, '\r\n'); return save(); };
    }
    return document;
  };
  const result = await f.host.applyEdit({ ...f.args(), path: path.join(f.root, 'normalized.txt'), text: 'first\nsecond\n', expectedHash: 'new' });
  assert.equal(result.hash, hashText('first\r\nsecond\r\n'));
  assert.equal(result.eol, 'CRLF');
});

test('concurrent edits of one canonical file serialize and reject the stale second hash', async t => {
  const f = await fixture(t);
  f.access.edit = true;
  const file = path.join(f.root, 'concurrent.txt');
  await fs.writeFile(file, 'initial');
  const applyEntered = deferred();
  const releaseApply = deferred();
  const originalApply = f.vscode.workspace.applyEdit;
  let entered = 0;
  f.vscode.workspace.applyEdit = async edit => {
    entered++;
    applyEntered.resolve();
    await releaseApply.promise;
    return originalApply(edit);
  };
  const shared = { ...f.args(), path: file, expectedHash: hashText('initial'), expectedVersion: 1 };
  const requests = [f.host.applyEdit({ ...shared, text: 'first writer' }), f.host.applyEdit({ ...shared, text: 'second writer' })];
  await applyEntered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, 1, 'The second edit must wait outside the editor mutation.');
  releaseApply.resolve();
  const results = await Promise.allSettled(requests);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'EDIT_CONFLICT');
  assert.equal(entered, 1);
  assert.equal(f.vscode.appliedEdits, 1);
  assert.equal(await fs.readFile(file, 'utf8'), results[0].status === 'fulfilled' ? 'first writer' : 'second writer');
});

test('concurrent new-file requests never overwrite the first creation', async t => {
  const f = await fixture(t);
  f.access.edit = true;
  const file = path.join(f.root, 'created-once.txt');
  const shared = { ...f.args(), path: file, expectedHash: 'new' };
  const results = await Promise.allSettled([f.host.applyEdit({ ...shared, text: 'first creation' }), f.host.applyEdit({ ...shared, text: 'second creation' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'FILE_EXISTS');
  assert.equal(f.vscode.appliedEdits, 1);
});

test('a junction swapped during editor mutation is rejected before saving outside content', async t => {
  const f = await fixture(t);
  f.access.edit = true;
  const folder = path.join(f.root, 'src');
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-host-outside-')));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'file.txt'), 'original');
  await fs.writeFile(path.join(outside, 'file.txt'), 'outside unchanged');
  const probe = path.join(f.root, 'probe');
  try { await fs.symlink(outside, probe, process.platform === 'win32' ? 'junction' : 'dir'); await fs.unlink(probe); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('This environment cannot create directory links.');
    throw error;
  }
  const originalApply = f.vscode.workspace.applyEdit;
  f.vscode.workspace.applyEdit = async edit => {
    const applied = await originalApply(edit);
    await fs.rename(folder, path.join(f.root, 'original-src'));
    await fs.symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
    return applied;
  };
  await assert.rejects(f.host.applyEdit({ ...f.args(), path: path.join(folder, 'file.txt'), text: 'proposed change', expectedHash: hashText('original'), expectedVersion: 1 }), { code: 'SYMLINK_DENIED' });
  assert.equal(await fs.readFile(path.join(outside, 'file.txt'), 'utf8'), 'outside unchanged');
  assert.equal(await fs.readFile(path.join(f.root, 'original-src', 'file.txt'), 'utf8'), 'original');
});

test('new-file diff needs edit access and writes no file', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'proposal.txt');
  await assert.rejects(f.host.previewDiff({ ...f.args(), path: file, text: 'proposal', expectedHash: 'new' }), { code: 'ACCESS_DENIED' });
  f.access.edit = true;
  assert.deepEqual(await f.host.previewDiff({ ...f.args(), path: file, text: 'proposal', expectedHash: 'new' }), { opened: true });
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  const call = f.vscode.commandCalls.at(-1);
  assert.equal(call.name, 'vscode.diff');
  assert.equal(call.args[0].scheme, call.args[1].scheme);
  assert.equal(f.vscode.contentProvider.provider.provideTextDocumentContent(call.args[0]), '');
  assert.equal(f.vscode.contentProvider.provider.provideTextDocumentContent(call.args[1]), 'proposal');
  f.host.resetSession();
  assert.equal(f.vscode.contentProvider.provider.provideTextDocumentContent(call.args[1]), '');
});

test('diagnostics contain relative paths and redact workspace prefixes', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'code.txt');
  await fs.writeFile(file, 'hello');
  const range = new f.vscode.Range(0, 0, 0, 3);
  f.vscode.diagnostics.set(f.vscode.Uri.file(file).toString(), [{ message: `See ${file}`, source: f.root, severity: 1, range }]);
  const diagnostics = await f.host.getDiagnostics(f.args());
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].path, 'code.txt');
  assert.equal(diagnostics[0].root, 0);
  assert.equal(diagnostics[0].message.includes(f.root), false);
  assert.equal(diagnostics[0].source, '[workspace]');
});

test('terminal always needs local approval and ignores stale approvals', async t => {
  const f = await fixture(t);
  await assert.rejects(f.host.executeTerminal({ ...f.args(), command: 'echo test', cwd: f.root }), { code: 'ACCESS_DENIED' });
  assert.equal(f.vscode.warningCalls.length, 0);
  f.access.terminal = true;
  await assert.rejects(f.host.executeTerminal({ ...f.args(), command: 'echo test', cwd: f.root }), { code: 'APPROVAL_DENIED' });
  assert.equal(f.vscode.warningCalls.length, 1);
  const pending = deferred();
  f.vscode.warningResponse = () => pending.promise;
  const execution = f.host.executeTerminal({ ...f.args(), command: 'echo test', cwd: f.root });
  while (f.vscode.warningCalls.length < 2) await new Promise(resolve => setImmediate(resolve));
  f.host.resetSession();
  pending.resolve('Run once');
  await assert.rejects(execution, { code: 'WORKSPACE_CHANGED' });
});

test('terminal approval expires and credential-targeting commands are denied', async t => {
  const f = await fixture(t);
  f.access.terminal = true;
  f.vscode.warningResponse = () => new Promise(() => {});
  await assert.rejects(f.host.executeTerminal({ ...f.args(), command: 'echo test', cwd: f.root }), { code: 'APPROVAL_DENIED' });
  const prompts = f.vscode.warningCalls.length;
  await assert.rejects(f.host.executeTerminal({ ...f.args(), command: 'cat .env', cwd: f.root }), { code: 'SENSITIVE_COMMAND' });
  assert.equal(f.vscode.warningCalls.length, prompts);
});

test('terminal environment excludes credentials and application state', () => {
  assert.deepEqual(safeEnvironment({ PATH: 'safe-path', SystemRoot: 'system', HOME: '/home', OPENAI_API_KEY: 'private', TOKEN: 'private', NODE_OPTIONS: '--require injected', APPDATA: 'private-appdata' }),
    { PATH: 'safe-path', SystemRoot: 'system', HOME: '/home' });
});

function loadExtension(vscode, startServer) {
  const filename = path.resolve(__dirname, '../src/extension.js');
  const nativeRequire = Module.createRequire(filename);
  const source = fsSync.readFileSync(filename, 'utf8');
  const loaded = { exports: {} };
  vm.runInThisContext(Module.wrap(source), { filename })(loaded.exports, name => {
    if (name === 'vscode') return vscode;
    if (name === './server') return { startServer };
    return nativeRequire(name);
  }, loaded, filename, path.dirname(filename));
  return loaded.exports;
}

async function extensionFixture(t, startServer) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-extension-')));
  const vscode = mockVscode(root);
  const secrets = new Map();
  const context = {
    subscriptions: [], extension: { packageJSON: { version: '0.1.0-test' } },
    secrets: { async get(key) { return secrets.get(key); }, async store(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); } },
  };
  let closes = 0;
  let starts = 0;
  const extension = loadExtension(vscode, startServer || (async options => { starts++; return { port: options.port, url: `http://127.0.0.1:${options.port}/mcp`, async close() { closes++; } }; }));
  const api = extension.activate(context);
  t.after(async () => { await extension.deactivate(); for (const disposable of context.subscriptions) disposable.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, vscode, api, context, secrets, extension, starts: () => starts, closes: () => closes,
    command: name => vscode.commandsMap.get(`workspaceBridge.${name}`)() };
}

test('extension starts read-only, exports metadata only, and revokes without waiting for a permission picker', async t => {
  const f = await extensionFixture(t);
  assert.equal(f.api.getStatus().running, false);
  await f.command('start');
  assert.deepEqual(f.api.getStatus().access, { read: true, edit: false, refactor: false, tasks: false, git: false, terminal: false });
  assert.equal(f.secrets.size, 1);
  assert.match([...f.secrets.values()][0], /^[a-f0-9]{64}$/);
  const statusKeys = Object.keys(f.api.getStatus()).sort();
  assert.deepEqual(statusKeys, ['access', 'running', 'url', 'workspaceId']);
  const picker = deferred();
  f.vscode.quickPickResponse = () => picker.promise;
  const pendingAccess = f.command('setAccess');
  await f.command('stop');
  assert.equal(f.api.getStatus().running, false);
  assert.deepEqual(f.api.getStatus().access, { read: false, edit: false, refactor: false, tasks: false, git: false, terminal: false });
  assert.equal(f.closes(), 1);
  picker.resolve([{ key: 'edit' }]);
  await pendingAccess;
  assert.equal(f.api.getStatus().access.edit, false);
});

test('stop during startup closes the late server instead of exposing it', async t => {
  const pendingServer = deferred();
  let options;
  let closes = 0;
  const f = await extensionFixture(t, async value => { options = value; return pendingServer.promise; });
  const starting = f.command('start');
  while (!options) await new Promise(resolve => setImmediate(resolve));
  const stopping = f.command('stop');
  assert.equal(f.api.getStatus().access.read, false);
  pendingServer.resolve({ port: 3338, url: 'http://127.0.0.1:3338/mcp', async close() { closes++; } });
  await Promise.all([starting, stopping]);
  assert.equal(closes, 1);
  assert.equal(f.api.getStatus().running, false);
});

test('local scoped grants expose every capability and disposal revokes the entire timed lease', async t => {
  const f = await extensionFixture(t);
  await f.command('start');
  f.vscode.quickPickResponse = async (_items, options) => options.canPickMany
    ? ['edit', 'refactor', 'tasks', 'git'].map(key => ({ key })) : { value: 1_800_000 };
  await f.command('setAccess');
  assert.deepEqual(f.api.getStatus().access, { read: true, edit: true, refactor: true, tasks: true, git: true, terminal: false });
  await f.extension.deactivate();
  assert.equal(Object.values(f.api.getStatus().access).some(Boolean), false);
});

test('workspace switches synchronously revoke access, stop, and remove old credentials', async t => {
  const f = await extensionFixture(t);
  await f.command('start');
  const previousId = f.api.getStatus().workspaceId;
  f.vscode.workspace.workspaceFolders = [{ name: 'Other', uri: f.vscode.Uri.file(path.join(f.root, 'other')) }];
  f.vscode.listeners.folders();
  assert.equal(f.api.getStatus().access.read, false);
  assert.notEqual(f.api.getStatus().workspaceId, previousId);
  while (f.api.getStatus().running || f.secrets.size) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.closes(), 1);
});

test('same-workspace windows use different tokens and disposal removes only their own credential', async t => {
  const first = await extensionFixture(t);
  await first.command('start');
  const firstToken = [...first.secrets.values()][0];
  await first.command('stop');
  await first.command('start');
  assert.equal([...first.secrets.values()][0], firstToken);
  const secondVscode = mockVscode(first.root);
  const secondContext = { ...first.context, subscriptions: [] };
  const second = loadExtension(secondVscode, async () => ({ port: 3339, url: 'http://127.0.0.1:3339/mcp', async close() {} }));
  second.activate(secondContext);
  t.after(async () => { await second.deactivate(); for (const disposable of secondContext.subscriptions) disposable.dispose(); });
  await secondVscode.commandsMap.get('workspaceBridge.start')();
  assert.equal(first.secrets.size, 2);
  assert.equal(new Set(first.secrets.values()).size, 2);
  await first.extension.deactivate();
  assert.equal(first.secrets.size, 1);
  assert.notEqual([...first.secrets.values()][0], firstToken);
  await second.deactivate();
  assert.equal(first.secrets.size, 0);
});
