'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const security = require('../src/security');
const { createVscodeHost } = require('../src/vscode-host');

async function fixture(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-navigation-')));
  const root = path.join(base, 'primary');
  const secondRoot = path.join(base, 'secondary');
  const outsideRoot = path.join(base, 'outside');
  await Promise.all([root, secondRoot, outsideRoot].map(value => fs.mkdir(value)));
  const file = path.join(root, 'source.js');
  const target = path.join(root, 'target.js');
  const secondTarget = path.join(secondRoot, 'other.js');
  const outside = path.join(outsideRoot, 'private.js');
  await Promise.all([file, target, secondTarget, outside, path.join(root, '.env')].map(value => fs.writeFile(value, 'const answer = 42;\n')));
  class Uri {
    constructor(value, scheme = 'file') { this.fsPath = value; this.scheme = scheme; }
    static file(value) { return new Uri(value); }
    toString() { return `${this.scheme}:${this.fsPath}`; }
  }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  const range = (sl = 0, sc = 0, el = 0, ec = 5) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });
  const document = { uri: Uri.file(file), version: 1, languageId: 'javascript', isDirty: false, text: 'const answer = 42;\n', getText() { return this.text; } };
  const access = { read: true, edit: false, terminal: false };
  const hooks = {};
  const commandCalls = [];
  const vscode = {
    Uri, Position, env: { language: 'en' },
    workspace: {
      isTrusted: true, name: 'Synthetic navigation project',
      workspaceFolders: [{ name: 'Primary', uri: Uri.file(root) }, { name: 'Secondary', uri: Uri.file(secondRoot) }],
      textDocuments: [document],
      registerTextDocumentContentProvider() { return { dispose() {} }; },
      async openTextDocument(uri) { assert.equal(uri.fsPath, file); return document; },
    },
    window: { tabGroups: { all: [] } },
    commands: { async executeCommand(name, ...args) {
      commandCalls.push({ name, args });
      return hooks.provider ? hooks.provider(name, ...args) : [];
    } },
  };
  const host = createVscodeHost({ ...options, vscode, getAccess: () => access, security: { ...security,
    async resolvePath(...args) {
      const resolved = await security.resolvePath(...args);
      if (hooks.resolve) await hooks.resolve(resolved, ...args);
      return resolved;
    },
  } });
  t.after(async () => {
    host.dispose();
    assert.equal(path.basename(base).startsWith('bridge-navigation-'), true);
    await fs.rm(base, { recursive: true, force: true });
  });
  const args = () => ({ workspaceId: host.getWorkspace().id });
  const location = (value = target, suppliedRange = range()) => ({ uri: Uri.file(value), range: suppliedRange });
  const symbol = (name = 'answer', value = target, suppliedRange = range()) => ({ name, kind: 12, location: location(value, suppliedRange) });
  return { base, root, secondRoot, outsideRoot, file, target, secondTarget, outside, vscode, document, access, hooks, commandCalls, host, args, range, location, symbol };
}

const methods = [
  ['getTypeDefinition', 'vscode.executeTypeDefinitionProvider'],
  ['getImplementations', 'vscode.executeImplementationProvider'],
];

test('workspace symbol search calls the fixed provider and returns relative locations from authorized roots', async t => {
  const f = await fixture(t);
  f.hooks.provider = () => [f.symbol(`answer in ${f.file}`), { ...f.symbol('secondary', f.secondTarget), containerName: 'must not be serialized', privateData: f.outside }];
  const result = await f.host.searchWorkspaceSymbols({ ...f.args(), query: 'answer' });
  assert.equal(f.commandCalls[0].name, 'vscode.executeWorkspaceSymbolProvider');
  assert.deepEqual(f.commandCalls[0].args, ['answer']);
  assert.deepEqual(result.symbols.map(value => ({ root: value.root, path: value.path })), [{ root: 0, path: 'target.js' }, { root: 1, path: 'other.js' }]);
  assert.equal(result.symbols[0].name, 'answer in [workspace]' + path.sep + 'source.js');
  assert.equal(result.untrusted, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(f.base), false);
  assert.equal(serialized.includes('privateData'), false);
  assert.equal(serialized.includes('containerName'), false);
});

test('workspace symbol search skips outside, hidden, missing, non-file, malformed and excessive-name entries', async t => {
  const f = await fixture(t);
  f.hooks.provider = () => [null, f.symbol('outside', f.outside), f.symbol('sensitive', path.join(f.root, '.env')),
    f.symbol('missing', path.join(f.root, 'missing.js')), { ...f.symbol('remote'), location: { uri: new f.vscode.Uri(f.target, 'https'), range: f.range() } },
    f.symbol('invalid-range', f.target, f.range(-1, 0, 0, 1)), f.symbol('reversed-range', f.target, f.range(1, 0, 0, 0)),
    f.symbol('too-long'.repeat(100)), f.symbol('ok')];
  const result = await f.host.searchWorkspaceSymbols({ ...f.args(), query: 'value' });
  assert.deepEqual(result.symbols.map(value => value.name), ['ok']);
  assert.equal(result.truncated, false);
  assert.equal(JSON.stringify(result).includes(f.outsideRoot), false);
});

test('workspace symbol search enforces result limits and bounds inspection to 1000 provider entries', async t => {
  const f = await fixture(t);
  f.hooks.provider = () => Array.from({ length: 5 }, (_, index) => f.symbol(`symbol-${index}`));
  const limited = await f.host.searchWorkspaceSymbols({ ...f.args(), query: 'symbol', limit: 2 });
  assert.equal(limited.symbols.length, 2);
  assert.equal(limited.truncated, true);
  f.hooks.provider = () => [...Array.from({ length: 1000 }, () => f.symbol('outside', f.outside)), f.symbol('beyond-inspection-budget')];
  const bounded = await f.host.searchWorkspaceSymbols({ ...f.args(), query: 'symbol' });
  assert.deepEqual(bounded.symbols, []);
  assert.equal(bounded.truncated, true);
});

test('workspace symbol search rejects invalid queries and credentials before calling a provider', async t => {
  const f = await fixture(t);
  for (const input of [{ query: '' }, { query: '   ' }, { query: 'x'.repeat(201) }, { query: 'x', limit: 0 }, { query: 'x', limit: 101 }, { query: 'x', limit: 1.5 }]) {
    await assert.rejects(f.host.searchWorkspaceSymbols({ ...f.args(), ...input }), { code: 'INVALID_QUERY' });
  }
  await assert.rejects(f.host.searchWorkspaceSymbols({ ...f.args(), query: ['gh', 'p_', 'a'.repeat(36)].join('') }), { code: 'SENSITIVE_CONTENT' });
  assert.deepEqual(f.commandCalls, []);
});

test('workspace symbol search rejects credential text in provider names and malformed top-level results', async t => {
  const f = await fixture(t);
  f.hooks.provider = () => [f.symbol(['gh', 'p_', 'a'.repeat(36)].join(''))];
  await assert.rejects(f.host.searchWorkspaceSymbols({ ...f.args(), query: 'answer' }), { code: 'SENSITIVE_CONTENT' });
  f.hooks.provider = () => ({ not: 'an array' });
  await assert.rejects(f.host.searchWorkspaceSymbols({ ...f.args(), query: 'answer' }), { code: 'INVALID_LANGUAGE_RESULT' });
});

test('workspace symbol search rejects stale session, access or workspace trust after provider completion', async t => {
  for (const change of ['session', 'access', 'trust']) {
    const f = await fixture(t);
    const input = { ...f.args(), query: 'answer' };
    f.hooks.provider = () => {
      if (change === 'session') f.host.resetSession();
      if (change === 'access') f.access.read = false;
      if (change === 'trust') f.vscode.workspace.isTrusted = false;
      return [f.symbol()];
    };
    await assert.rejects(f.host.searchWorkspaceSymbols(input), { code: { session: 'WORKSPACE_CHANGED', access: 'ACCESS_DENIED', trust: 'UNTRUSTED_WORKSPACE' }[change] });
  }
});

test('workspace symbol search enforces a bounded language-service timeout', async t => {
  const f = await fixture(t, { languageTimeoutMs: 10 });
  f.hooks.provider = () => new Promise(() => {});
  await assert.rejects(f.host.searchWorkspaceSymbols({ ...f.args(), query: 'answer' }), { code: 'LANGUAGE_TIMEOUT' });
});

test('type and implementation navigation use fixed providers and serialize only relative Location/LocationLink fields', async t => {
  for (const [method, command] of methods) {
    const f = await fixture(t);
    f.hooks.provider = () => [f.location(), { targetUri: f.vscode.Uri.file(f.secondTarget), targetRange: f.range(0, 0, 3, 0),
      targetSelectionRange: f.range(1, 2, 1, 9), originSelectionRange: f.range(), privateData: f.outside }];
    const result = await f.host[method]({ ...f.args(), path: f.file, line: 0, character: 7 });
    assert.equal(f.commandCalls[0].name, command);
    assert.equal(f.commandCalls[0].args[0].fsPath, f.file);
    assert.deepEqual(f.commandCalls[0].args[1], new f.vscode.Position(0, 7));
    assert.deepEqual(result, [{ root: 0, path: 'target.js', range: f.range() }, { root: 1, path: 'other.js', range: f.range(1, 2, 1, 9) }]);
    assert.equal(JSON.stringify(result).includes(f.base), false);
    assert.equal(JSON.stringify(result).includes('privateData'), false);
  }
});

test('type and implementation navigation filter unsafe paths and malformed entries without dropping valid locations', async t => {
  for (const [method] of methods) {
    const f = await fixture(t);
    f.hooks.provider = () => [null, {}, f.location(f.outside), f.location(path.join(f.root, '.env')), f.location(path.join(f.root, 'missing.js')),
      { uri: new f.vscode.Uri(f.target, 'untitled'), range: f.range() }, f.location(f.target, f.range(-1, 0, 0, 1)),
      f.location(f.target, f.range(2, 0, 1, 0)), f.location()];
    assert.deepEqual(await f.host[method]({ ...f.args(), path: f.file, line: 0, character: 0 }), [{ root: 0, path: 'target.js', range: f.range() }]);
  }
});

test('type and implementation navigation reject invalid source positions before running providers', async t => {
  const f = await fixture(t);
  for (const [method] of methods) {
    for (const [line, character] of [[-1, 0], [0, -1], [0.5, 0], [0, 0.5], [2, 0], [0, 19]]) {
      await assert.rejects(f.host[method]({ ...f.args(), path: f.file, line, character }), { code: 'INVALID_POSITION' });
    }
    await assert.rejects(f.host[method]({ ...f.args(), path: f.outside, line: 0, character: 0 }), { code: 'OUTSIDE_WORKSPACE' });
    await assert.rejects(f.host[method]({ ...f.args(), path: path.join(f.root, '.env'), line: 0, character: 0 }), { code: 'OUTSIDE_WORKSPACE' });
  }
  assert.deepEqual(f.commandCalls, []);
});

test('type and implementation navigation bound returned locations to 200', async t => {
  for (const [method] of methods) {
    const f = await fixture(t);
    f.hooks.provider = () => Array.from({ length: 205 }, () => f.location());
    const result = await f.host[method]({ ...f.args(), path: f.file, line: 0, character: 0 });
    assert.equal(result.length, 200);
    assert.equal(JSON.stringify(result).includes(f.root), false);
  }
});

test('type and implementation navigation reject oversized source files and unsaved buffers', async t => {
  for (const [method] of methods) {
    const f = await fixture(t);
    await fs.writeFile(f.file, 'x'.repeat(512 * 1024 + 1));
    await assert.rejects(f.host[method]({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'FILE_TOO_LARGE' });
    await fs.writeFile(f.file, 'small');
    f.document.text = 'x'.repeat(512 * 1024 + 1);
    f.document.isDirty = true;
    await assert.rejects(f.host[method]({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'FILE_TOO_LARGE' });
    assert.deepEqual(f.commandCalls, []);
  }
});

test('type and implementation navigation reject document/session/permission changes while a provider runs', async t => {
  for (const [method] of methods) {
    for (const change of ['version', 'session', 'access']) {
      const f = await fixture(t);
      const input = { ...f.args(), path: f.file, line: 0, character: 0 };
      f.hooks.provider = () => {
        if (change === 'version') f.document.version++;
        if (change === 'session') f.host.resetSession();
        if (change === 'access') f.access.read = false;
        return [f.location()];
      };
      await assert.rejects(f.host[method](input), { code: { version: 'DOCUMENT_CHANGED', session: 'WORKSPACE_CHANGED', access: 'ACCESS_DENIED' }[change] });
    }
  }
});

test('type and implementation navigation reject stale source versions during asynchronous target filtering', async t => {
  for (const [method] of methods) {
    const f = await fixture(t);
    f.hooks.provider = () => [f.location()];
    f.hooks.resolve = resolved => { if (resolved === f.target) f.document.version++; };
    await assert.rejects(f.host[method]({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'DOCUMENT_CHANGED' });
  }
});

test('type and implementation navigation enforce provider timeouts and reject malformed top-level results', async t => {
  for (const [method] of methods) {
    const f = await fixture(t, { languageTimeoutMs: 10 });
    f.hooks.provider = () => new Promise(() => {});
    await assert.rejects(f.host[method]({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'LANGUAGE_TIMEOUT' });
    f.hooks.provider = () => ({ not: 'an array' });
    await assert.rejects(f.host[method]({ ...f.args(), path: f.file, line: 0, character: 0 }), { code: 'INVALID_LANGUAGE_RESULT' });
  }
});

test('all new navigation methods exclude linked targets', async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'linked');
  try { await fs.symlink(f.outsideRoot, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('This environment cannot create directory links.'); throw error; }
  const linked = path.join(alias, 'private.js');
  f.hooks.provider = () => [f.symbol('linked', linked), f.symbol('safe')];
  const symbols = await f.host.searchWorkspaceSymbols({ ...f.args(), query: 'value' });
  assert.deepEqual(symbols.symbols.map(value => value.name), ['safe']);
  f.hooks.provider = () => [f.location(linked), f.location()];
  for (const [method] of methods) {
    assert.deepEqual(await f.host[method]({ ...f.args(), path: f.file, line: 0, character: 0 }), [{ root: 0, path: 'target.js', range: f.range() }]);
  }
});
