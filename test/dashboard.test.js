'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createDashboard, createDashboardHtml, sanitizeDashboardState, validateDashboardMessage } = require('../src/dashboard');

function metadata() {
  return {
    version: '0.3.0', running: true, url: 'http://127.0.0.1:3338/mcp',
    workspace: { name: 'Example project', rootCount: 1, trusted: true },
    access: { read: true, edit: false, terminal: true },
    tools: [{ name: 'read_file', description: 'Read a workspace file.', capability: 'read', category: 'Files' },
      { name: 'replace_text', description: 'Preview a precise change.', capability: 'edit', category: 'Editing' }],
    tasks: [{ id: 'task-1', name: 'Terminal task', status: 'awaiting_approval', createdAt: '2026-01-01T00:00:00.000Z', durationMs: 200 }],
    recentRequests: [{ time: '2026-01-01T00:00:00.000Z', tool: 'read_file', status: 'completed', durationMs: 12 }],
  };
}

function fixture(getState = metadata, action = async () => {}) {
  const panels = [];
  const actions = [];
  const vscode = {
    env: { language: 'en' }, ViewColumn: { Active: 1 },
    window: { createWebviewPanel(type, title, column, options) {
      const listeners = {};
      const disposable = name => callback => {
        listeners[name] = callback;
        return { dispose() { if (listeners[name] === callback) delete listeners[name]; } };
      };
      const panel = {
        type, title, column, options, listeners, visible: true, reveals: 0, disposed: false,
        webview: { html: '', messages: [], async postMessage(message) { this.messages.push(message); return true; }, onDidReceiveMessage: disposable('message') },
        onDidDispose: disposable('dispose'), onDidChangeViewState: disposable('view'),
        reveal() { this.reveals++; },
        dispose() { this.disposed = true; listeners.dispose?.(); },
      };
      panels.push(panel); return panel;
    } },
  };
  const dashboard = createDashboard({ vscode, context: { subscriptions: [] }, getState,
    async onAction(name, payload) { actions.push({ name, payload }); await action(name, payload); } });
  return { dashboard, panels, actions, vscode };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('dashboard projects an allowlist and never forwards credential, path, command, or output fields', () => {
  const state = metadata();
  const privateValue = ['not', 'publication', 'material'].join('-');
  state.token = privateValue; state.command = privateValue; state.output = privateValue;
  state.workspace.path = privateValue; state.workspace.roots = [privateValue];
  state.tasks[0].command = privateValue; state.tasks[0].output = privateValue; state.tasks[0].cwd = privateValue;
  state.tools[0].inputSchema = { privateValue };
  state.recentRequests[0].body = privateValue; state.recentRequests[0].error = privateValue;
  state.lastError = 'SAFE_ENUM_CODE';
  const safe = sanitizeDashboardState(state);
  assert.equal(JSON.stringify(safe).includes(privateValue), false);
  assert.deepEqual(Object.keys(safe), ['version', 'running', 'url', 'workspace', 'access', 'tools', 'tasks', 'recentRequests', 'lastError']);
  assert.deepEqual(Object.keys(safe.workspace), ['name', 'rootCount', 'trusted']);
  assert.equal(safe.tasks[0].status, 'awaiting_approval');
  assert.equal(safe.lastError, 'SAFE_ENUM_CODE');
});

test('dashboard rejects remote or credential-bearing URLs and unsafe text metadata', () => {
  for (const url of ['https://example.com/mcp', 'http://example.com/mcp', 'http://127.0.0.1:3338/mcp?token=placeholder',
    ['http://', 'user', ':', 'placeholder', '@', 'localhost:3338/mcp'].join(''), 'http://localhost:3338/mcp#secret', 'http://localhost:3338/another-path', 'file:///example']) {
    assert.equal(sanitizeDashboardState({ url }).url, '');
  }
  for (const url of ['http://localhost:3338/mcp', 'http://127.0.0.1:3338/mcp', 'http://[::1]:3338/mcp']) assert.equal(sanitizeDashboardState({ url }).url, url);
  const secret = ['gh', 'p_', 'x'.repeat(36)].join('');
  const windowsPath = String.fromCharCode(67, 58, 92) + 'private' + String.fromCharCode(92) + 'project';
  const state = metadata();
  state.workspace.name = windowsPath;
  state.tools[0].description = secret;
  state.tasks[0].name = `Bearer ${'a'.repeat(64)}`;
  state.lastError = 'Something failed at private-path';
  const safe = sanitizeDashboardState(state);
  assert.equal(safe.workspace.name, ''); assert.equal(safe.tools[0].description, ''); assert.equal(safe.tasks[0].name, '');
  assert.equal(Object.hasOwn(safe, 'lastError'), false);
  assert.equal(JSON.stringify(safe).includes(secret), false);
});

test('dashboard bounds metadata and accepts only valid values and known task states', () => {
  const state = metadata();
  state.version = '<script>'; state.workspace.rootCount = Infinity; state.access.read = 'true';
  state.tools = Array.from({ length: 300 }, () => state.tools[0]);
  state.tasks.push({ id: 'invalid task id', status: 'running' }, { id: 'task-2', status: 'invented-state' },
    { id: 'task-3', name: 'Terminal task', status: 'rejected', durationMs: -2, createdAt: 'bad', exitCode: 2, truncated: true });
  state.recentRequests = Array.from({ length: 80 }, () => state.recentRequests[0]);
  const safe = sanitizeDashboardState(state);
  assert.equal(safe.version, ''); assert.equal(safe.workspace.rootCount, 0); assert.equal(safe.access.read, false);
  assert.equal(safe.tools.length, 200); assert.equal(safe.recentRequests.length, 50); assert.equal(safe.tasks.length, 2);
  assert.deepEqual(safe.tasks[1], { id: 'task-3', name: 'Terminal task', status: 'rejected', durationMs: 0, createdAt: '', exitCode: 2, truncated: true });
  assert.deepEqual(sanitizeDashboardState(null), { version: '', running: false, url: '', workspace: { name: '', rootCount: 0, trusted: false }, access: { read: false, edit: false, terminal: false }, tools: [], tasks: [], recentRequests: [] });
});

test('message validation permits only documented local actions and exact cancellation payloads', () => {
  assert.deepEqual(validateDashboardMessage({ type: 'ready' }), { type: 'ready' });
  for (const action of ['start', 'stop', 'access', 'copyConnection', 'copyPrompt', 'rotateToken', 'exportDiagnostics']) {
    assert.deepEqual(validateDashboardMessage({ type: 'action', action }), { type: 'action', action });
    assert.equal(validateDashboardMessage({ type: 'action', action, payload: { command: 'anything' } }), undefined);
  }
  assert.deepEqual(validateDashboardMessage({ type: 'action', action: 'cancelTask', payload: { id: 'task-1' } }), { type: 'action', action: 'cancelTask', payload: { id: 'task-1' } });
  for (const value of [null, [], 'start', { type: 'ready', url: 'http://example.com' }, { type: 'action', action: 'executeCommand' },
    { type: 'action', action: 'cancelTask' }, { type: 'action', action: 'cancelTask', payload: { id: 3 } },
    { type: 'action', action: 'cancelTask', payload: { id: 'task-1', command: 'anything' } },
    { type: 'action', action: 'cancelTask', payload: { id: '../outside' } },
    { type: 'action', action: 'start', text: 'x'.repeat(5000) }, { type: 'action', action: 'start', prototype: true },
    Object.assign(Object.create({ inherited: true }), { type: 'action', action: 'start' })]) assert.equal(validateDashboardMessage(value), undefined);
  const cyclic = { type: 'action', action: 'start' }; cyclic.self = cyclic;
  assert.equal(validateDashboardMessage(cyclic), undefined);
});

test('dashboard HTML has a restrictive CSP, nonce-only scripts and styles, no external links or dynamic markup sinks', () => {
  const nonce = 'a'.repeat(32);
  const html = createDashboardHtml('en', nonce);
  assert.match(html, /default-src 'none'/); assert.match(html, /connect-src 'none'/); assert.match(html, /form-action 'none'/);
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert.equal((html.match(/<style\b/g) || []).length, 1);
  assert.match(html, new RegExp(`<script nonce="${nonce}">`)); assert.match(html, new RegExp(`<style nonce="${nonce}">`));
  assert.doesNotMatch(html, /unsafe-inline|https?:\/\/|\b(?:src|href|onclick|onerror)=|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|eval\(|new Function/);
  const script = html.match(/<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /textContent/); assert.match(html, /aria-live="polite"/); assert.match(html, /:focus-visible/);
  assert.match(createDashboardHtml('zh-CN', nonce), /等待本机确认/);
  assert.throws(() => createDashboardHtml('en', 'unsafe" nonce'), TypeError);
});

test('panel opens once, uses safe options, updates only through sanitized postMessage, and disposes cleanly', async () => {
  const state = metadata(); state.token = 'placeholder-hidden-value';
  const f = fixture(() => state);
  const panel = f.dashboard.open();
  await settle();
  assert.equal(f.panels.length, 1);
  assert.deepEqual(panel.options, { enableScripts: true, enableCommandUris: false, retainContextWhenHidden: false, localResourceRoots: [] });
  assert.equal(panel.webview.html.includes('Example project'), false, 'Workspace metadata is absent from static HTML.');
  assert.equal(JSON.stringify(panel.webview.messages).includes('placeholder-hidden-value'), false);
  assert.equal(panel.webview.messages[0].type, 'state');
  assert.equal(panel.webview.messages[0].state.workspace.name, 'Example project');
  f.dashboard.open(); await settle(); assert.equal(f.panels.length, 1); assert.equal(panel.reveals, 1);
  state.running = false; await f.dashboard.update(); assert.equal(panel.webview.messages.at(-1).state.running, false);
  f.dashboard.dispose(); f.dashboard.dispose();
  const count = panel.webview.messages.length;
  await f.dashboard.update(); assert.equal(f.dashboard.open(), undefined);
  assert.equal(panel.disposed, true); assert.deepEqual(Object.keys(panel.listeners), []); assert.equal(panel.webview.messages.length, count);
});

test('only validated actions reach host callbacks and task cancellation checks current host ownership', async () => {
  const state = metadata(); const f = fixture(() => state); const panel = f.dashboard.open(); await settle();
  panel.listeners.message({ type: 'action', action: 'executeCommand', payload: { command: 'anything' } });
  panel.listeners.message({ type: 'action', action: 'cancelTask', payload: { id: 'not-owned' } });
  await settle(); assert.equal(f.actions.length, 0); assert.deepEqual(panel.webview.messages.at(-2), { type: 'actionResult', ok: false });
  panel.listeners.message({ type: 'action', action: 'cancelTask', payload: { id: 'task-1' } });
  await settle(); assert.deepEqual(f.actions, [{ name: 'cancelTask', payload: { id: 'task-1' } }]);
  state.tasks[0].status = 'completed';
  panel.listeners.message({ type: 'action', action: 'cancelTask', payload: { id: 'task-1' } });
  await settle(); assert.equal(f.actions.length, 1);
  panel.listeners.message({ type: 'action', action: 'access' }); await settle();
  assert.deepEqual(f.actions[1], { name: 'access', payload: undefined });
  f.dashboard.dispose();
});

test('host errors are reduced to a result flag and do not send error messages or stacks to the webview', async () => {
  const f = fixture(metadata, async () => { throw new Error('private failure content'); });
  const panel = f.dashboard.open(); await settle(); panel.listeners.message({ type: 'action', action: 'start' }); await settle();
  assert.deepEqual(panel.webview.messages.find(message => message.type === 'actionResult'), { type: 'actionResult', ok: false });
  assert.equal(JSON.stringify(panel.webview.messages).includes('private failure content'), false);
  f.dashboard.dispose();
  const g = fixture(() => { throw new Error('private state content'); });
  const broken = g.dashboard.open(); await settle(); assert.equal(broken.webview.messages[0].state.lastError, 'STATE_UNAVAILABLE');
  assert.equal(JSON.stringify(broken.webview.messages).includes('private state content'), false); g.dashboard.dispose();
});

test('stop and owned-task cancellation remain available while a local permission dialog is pending', async () => {
  let finishAccess;
  const f = fixture(metadata, async name => { if (name === 'access') await new Promise(resolve => { finishAccess = resolve; }); });
  const panel = f.dashboard.open(); await settle();
  panel.listeners.message({ type: 'action', action: 'access' }); await settle();
  panel.listeners.message({ type: 'action', action: 'stop' });
  panel.listeners.message({ type: 'action', action: 'cancelTask', payload: { id: 'task-1' } });
  await settle();
  assert.deepEqual(f.actions.map(action => action.name), ['access', 'stop', 'cancelTask']);
  finishAccess(); await settle(); f.dashboard.dispose();
});

test('stopping is valid task metadata but is not cancellable again', async () => {
  const state = metadata(); state.tasks[0].status = 'stopping';
  assert.equal(sanitizeDashboardState(state).tasks[0].status, 'stopping');
  const f = fixture(() => state); const panel = f.dashboard.open(); await settle();
  panel.listeners.message({ type: 'action', action: 'cancelTask', payload: { id: 'task-1' } }); await settle();
  assert.equal(f.actions.length, 0); f.dashboard.dispose();
});

test('a late state snapshot cannot overwrite a newer update or post after disposal', async () => {
  const waiting = [];
  const f = fixture(() => new Promise(resolve => waiting.push(resolve)));
  const panel = f.dashboard.open(); const newer = f.dashboard.update();
  waiting[1]({ ...metadata(), running: false }); await newer;
  waiting[0](metadata()); await settle();
  assert.equal(panel.webview.messages.length, 1); assert.equal(panel.webview.messages[0].state.running, false);
  const late = f.dashboard.update(); f.dashboard.dispose(); waiting[2](metadata()); await late;
  assert.equal(panel.webview.messages.length, 1);
});

test('closing a panel removes handlers and reopening uses a new nonce and localized static shell', async () => {
  const f = fixture(); f.vscode.env.language = 'zh-CN';
  const first = f.dashboard.open(); await settle(); first.dispose();
  assert.deepEqual(Object.keys(first.listeners), []);
  const second = f.dashboard.open(); await settle();
  assert.equal(second.title, '工作区桥接'); assert.notEqual(first.webview.html, second.webview.html);
  f.dashboard.dispose();
});
