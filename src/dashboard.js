'use strict';

const crypto = require('node:crypto');

const ACTIONS = new Set(['start', 'stop', 'access', 'copyConnection', 'copyPrompt', 'rotateToken', 'exportDiagnostics', 'cancelTask']);
const CAPABILITIES = new Set(['read', 'edit', 'terminal']);
const TASK_STATUSES = new Set(['queued', 'pending', 'awaiting_approval', 'running', 'stopping', 'completed', 'succeeded', 'failed', 'cancelled', 'timed_out', 'rejected']);
const ACTIVE_STATUSES = new Set(['queued', 'pending', 'awaiting_approval', 'running']);
const MAX_MESSAGE_BYTES = 4096;

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function identifier(value, maximum = 80) {
  return typeof value === 'string' && value.length <= maximum && /^[a-zA-Z0-9_.:-]+$/.test(value) ? value : undefined;
}

function displayText(value, maximum, fallback = '') {
  if (typeof value !== 'string' || value.length > maximum * 4) return fallback;
  // Treat this as an extra barrier: callers must still provide metadata only.
  if (/(?:[a-z]:[\\/]|\\\\|\/(?:Users|home)\/|\bbearer\s+\S+|\b(?:gh[pousr]_|github_pat_|sk-(?:proj-|live-)?|xox[baprs]-)[a-zA-Z0-9_-]{20,}|-----BEGIN|\b[a-f0-9]{64}\b)/i.test(value)) return fallback;
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, maximum) || fallback;
}

function number(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 32 || !/^\d{4}-\d\d-\d\dT\d\d[:]\d\d[:]\d\d(?:\.\d{1,3})?Z$/.test(value)) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function localEndpoint(value) {
  if (typeof value !== 'string' || value.length > 128) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') return '';
    return url.toString();
  } catch { return ''; }
}

/** Only this allowlisted projection may cross into the webview. */
function sanitizeDashboardState(value) {
  const source = record(value) ? value : {};
  const workspace = record(source.workspace) ? source.workspace : {};
  const access = record(source.access) ? source.access : {};
  const tools = Array.isArray(source.tools) ? source.tools : [];
  const tasks = Array.isArray(source.tasks) ? source.tasks : [];
  const requests = Array.isArray(source.recentRequests) ? source.recentRequests : [];
  const result = {
    version: typeof source.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9.-]{1,40})?$/.test(source.version) ? source.version : '',
    running: source.running === true,
    url: localEndpoint(source.url),
    workspace: { name: displayText(workspace.name, 120), rootCount: number(workspace.rootCount, 10000), trusted: workspace.trusted === true },
    access: { read: access.read === true, edit: access.edit === true, terminal: access.terminal === true },
    tools: tools.slice(0, 200).flatMap(tool => {
      if (!record(tool) || !identifier(tool.name) || !CAPABILITIES.has(tool.capability)) return [];
      return [{ name: tool.name, description: displayText(tool.description, 400), capability: tool.capability, category: displayText(tool.category, 60) }];
    }),
    tasks: tasks.slice(0, 40).flatMap(task => {
      if (!record(task) || !identifier(task.id, 128) || !TASK_STATUSES.has(task.status)) return [];
      return [{ id: task.id, name: displayText(task.name, 120), status: task.status, createdAt: timestamp(task.createdAt), durationMs: number(task.durationMs),
        ...(Number.isSafeInteger(task.exitCode) && Math.abs(task.exitCode) <= 2147483647 ? { exitCode: task.exitCode } : {}),
        ...(typeof task.truncated === 'boolean' ? { truncated: task.truncated } : {}) }];
    }),
    recentRequests: requests.slice(0, 50).flatMap(request => {
      if (!record(request) || !identifier(request.tool) || !identifier(request.status, 60)) return [];
      return [{ time: timestamp(request.time), tool: request.tool, status: request.status, durationMs: number(request.durationMs) }];
    }),
  };
  if (typeof source.lastError === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(source.lastError)) result.lastError = source.lastError;
  return result;
}

function validateDashboardMessage(value) {
  if (!record(value)) return undefined;
  try { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_MESSAGE_BYTES) return undefined; } catch { return undefined; }
  if (value.type === 'ready' && exactKeys(value, ['type'])) return { type: 'ready' };
  if (value.type !== 'action' || !ACTIONS.has(value.action)) return undefined;
  if (value.action === 'cancelTask') {
    if (!exactKeys(value, ['type', 'action', 'payload']) || !record(value.payload) || !exactKeys(value.payload, ['id']) || !identifier(value.payload.id, 128)) return undefined;
    return { type: 'action', action: 'cancelTask', payload: { id: value.payload.id } };
  }
  return exactKeys(value, ['type', 'action']) ? { type: 'action', action: value.action } : undefined;
}

const EN = {
  title: 'Workspace Bridge', subtitle: 'Your editor. Your permissions.', overview: 'Control center', local: 'LOCAL MCP', version: 'Version', running: 'Running locally', stopped: 'Bridge stopped',
  runningDetail: 'A trusted MCP client can use the permissions enabled below.', stoppedDetail: 'Start a read-only session to connect a trusted MCP client.', start: 'Start bridge', stop: 'Stop bridge',
  copyConnection: 'Copy client configuration', copyPrompt: 'Copy starter prompt', access: 'Manage access', rotateToken: 'Rotate token', exportDiagnostics: 'Export diagnostics',
  workspace: 'Workspace', noWorkspace: 'No workspace open', roots: 'roots', trusted: 'Trusted', untrusted: 'Trust required', endpoint: 'Connection address', offline: 'Start to get a local address',
  read: 'Read', edit: 'Edit', terminal: 'Terminal', enabled: 'Enabled', locked: 'Locked', session: 'This session', tools: 'Tool directory', toolsHint: 'Explore what a connected model can do. Permissions are controlled locally.',
  search: 'Search tool names and descriptions', all: 'All tools', available: 'Available', noTools: 'No tools match your search.', toolCount: 'tools',
  tasks: 'Background tasks', tasksHint: 'Only tasks started by this bridge are listed. Commands and output stay out of this view.', noTasks: 'No background tasks yet.', cancel: 'Cancel task', taskId: 'Task',
  requests: 'Recent requests', requestsHint: 'Activity metadata only. No file contents, prompts, commands, or output.', noRequests: 'No requests in this session.', time: 'Time', tool: 'Tool', status: 'Status', duration: 'Duration',
  security: 'Built for deliberate access', securityHint: 'The bridge connects your MCP client to the editor; it does not include an AI model.',
  localTitle: 'Local connection', localText: 'Loopback HTTP with bearer authentication. Keep copied client credentials private.',
  sessionTitle: 'Session permissions', sessionText: 'The bridge starts read-only. Editing is enabled explicitly for the current session.',
  terminalTitle: 'Confirm each command', terminalText: 'Terminal access requires local approval for every command and uses your account permissions.',
  quickActions: 'Connection actions', loading: 'Loading bridge state…', updated: 'State updated', failed: 'The action could not be completed. Review the local notification.', error: 'Last error',
  active: 'Active', finished: 'Finished', elapsed: 'Elapsed', exitCode: 'Exit code', truncated: 'Output limit reached', refresh: 'Refresh state',
  queued: 'Queued', pending: 'Pending', awaiting_approval: 'Awaiting local approval', stopping: 'Stopping', rejected: 'Not approved', runningTask: 'Running', completed: 'Completed', succeeded: 'Succeeded', failedTask: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out',
};
const ZH = {
  title: '工作区桥接', subtitle: '你的编辑器，由你掌控。', overview: '集中控制台', local: '本地 MCP', version: '版本', running: '本地运行中', stopped: '桥接已停止',
  runningDetail: '可信 MCP 客户端可以使用下方已开放的权限。', stoppedDetail: '启动只读会话，再连接你信任的 MCP 客户端。', start: '启动桥接', stop: '停止桥接',
  copyConnection: '复制客户端配置', copyPrompt: '复制起步提示词', access: '管理访问权限', rotateToken: '更换密钥', exportDiagnostics: '导出诊断',
  workspace: '工作区', noWorkspace: '尚未打开工作区', roots: '个根目录', trusted: '已信任', untrusted: '需要信任工作区', endpoint: '连接地址', offline: '启动后显示本机地址',
  read: '读取', edit: '修改', terminal: '终端', enabled: '已开放', locked: '未开放', session: '仅当前会话', tools: '工具目录', toolsHint: '了解连接后的模型可以做什么。访问权限由你在本机控制。',
  search: '搜索工具名称和说明', all: '全部工具', available: '可使用', noTools: '没有匹配的工具。', toolCount: '个工具',
  tasks: '后台任务', tasksHint: '仅列出通过本桥接启动的任务，此处不展示命令和输出。', noTasks: '尚无后台任务。', cancel: '取消任务', taskId: '任务',
  requests: '最近请求', requestsHint: '仅记录活动元数据，不含文件正文、提示词、命令或输出。', noRequests: '本次会话尚无请求。', time: '时间', tool: '工具', status: '状态', duration: '耗时',
  security: '每次访问，都有边界', securityHint: '桥接负责连接 MCP 客户端与编辑器，本身不包含 AI 模型。',
  localTitle: '本机连接', localText: '使用本机回环 HTTP 和 bearer 身份认证。复制的客户端配置含密钥，请妥善保管。',
  sessionTitle: '会话权限', sessionText: '启动时仅允许读取。修改权限由你明确开启，且仅在当前会话有效。',
  terminalTitle: '每条命令，本机确认', terminalText: '终端访问需要你逐条确认命令，并使用你当前账户的权限运行。',
  quickActions: '连接操作', loading: '正在读取桥接状态…', updated: '状态已更新', failed: '操作未完成，请查看本机通知。', error: '最近错误',
  active: '进行中', finished: '已结束', elapsed: '已用时', exitCode: '退出码', truncated: '已达到输出上限', refresh: '刷新状态',
  queued: '排队中', pending: '等待中', awaiting_approval: '等待本机确认', stopping: '停止中', rejected: '未获批准', runningTask: '运行中', completed: '已完成', succeeded: '成功', failedTask: '失败', cancelled: '已取消', timed_out: '已超时',
};

function escapeHtml(value) { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }

/** This script is intentionally self-contained: no network, imports, or HTML injection. */
function dashboardClient(T) {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let state;
  let filter = 'all';
  let pending = 0;
  const activeStatuses = new Set(['queued', 'pending', 'awaiting_approval', 'running']);
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };
  const duration = milliseconds => milliseconds < 1000 ? `${milliseconds} ms` : milliseconds < 60000 ? `${(milliseconds / 1000).toFixed(1)} s` : `${Math.floor(milliseconds / 60000)} m ${Math.floor(milliseconds % 60000 / 1000)} s`;
  const taskStatus = status => ({ running: T.runningTask, failed: T.failedTask })[status] || T[status] || status;
  function sendAction(action, payload) {
    if (pending && action !== 'stop' && action !== 'cancelTask') return;
    pending++;
    document.body.classList.add('busy');
    $('announcement').textContent = T.loading;
    vscode.postMessage({ type: 'action', action, ...(payload ? { payload } : {}) });
  }
  function setPill(element, label, enabled) {
    element.textContent = label;
    element.className = `pill ${enabled ? 'positive' : 'muted'}`;
  }
  function renderTools() {
    if (!state) return;
    const query = $('tool-search').value.toLocaleLowerCase().trim();
    const visible = state.tools.filter(tool => (filter === 'all' || tool.capability === filter) && `${tool.name} ${tool.description} ${tool.category}`.toLocaleLowerCase().includes(query));
    $('tool-count').textContent = `${visible.length} / ${state.tools.length} ${T.toolCount}`;
    const groups = [];
    for (const capability of ['read', 'edit', 'terminal']) {
      const tools = visible.filter(tool => tool.capability === capability);
      if (!tools.length) continue;
      const group = make('section', 'tool-group');
      const heading = make('div', 'group-heading');
      heading.append(make('h3', '', T[capability]), make('span', 'count', tools.length));
      group.append(heading);
      const grid = make('div', 'tool-grid');
      for (const tool of tools) {
        const available = state.running && state.access[capability];
        const card = make('article', `tool-card${available ? '' : ' tool-locked'}`);
        const top = make('div', 'tool-top');
        top.append(make('code', 'tool-name', tool.name), make('span', `tool-availability ${available ? 'positive-text' : ''}`, available ? T.available : T.locked));
        card.append(top, make('p', '', tool.description));
        if (tool.category) card.append(make('span', 'tool-category', tool.category));
        grid.append(card);
      }
      group.append(grid); groups.push(group);
    }
    $('tool-list').replaceChildren(...(groups.length ? groups : [make('p', 'empty', T.noTools)]));
  }
  function renderTasks() {
    const rows = state.tasks.map(task => {
      const cancellable = activeStatuses.has(task.status);
      const active = cancellable || task.status === 'stopping';
      const row = make('article', 'task-row');
      const details = make('div', 'task-detail');
      details.append(make('strong', '', task.name || T.taskId));
      const sub = make('div', 'task-meta');
      sub.append(make('code', '', task.id), make('span', '', `${T.elapsed} ${duration(task.durationMs)}`));
      if (task.exitCode !== undefined) sub.append(make('span', '', `${T.exitCode} ${task.exitCode}`));
      if (task.truncated) sub.append(make('span', '', T.truncated));
      details.append(sub);
      const actions = make('div', 'task-actions');
      actions.append(make('span', `pill ${active ? 'positive' : 'muted'}`, taskStatus(task.status)));
      if (cancellable) {
        const button = make('button', 'button secondary compact', T.cancel);
        button.type = 'button'; button.setAttribute('aria-label', `${T.cancel}: ${task.name || task.id}`);
        button.addEventListener('click', () => sendAction('cancelTask', { id: task.id }));
        actions.append(button);
      }
      row.append(details, actions); return row;
    });
    $('task-list').replaceChildren(...(rows.length ? rows : [make('p', 'empty', T.noTasks)]));
    $('task-count').textContent = String(state.tasks.filter(task => activeStatuses.has(task.status) || task.status === 'stopping').length);
  }
  function renderRequests() {
    const rows = state.recentRequests.map(request => {
      const row = make('tr');
      let time = '—';
      if (request.time) time = new Date(request.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      row.append(make('td', 'mono', time));
      const tool = make('td'); tool.append(make('code', '', request.tool)); row.append(tool);
      row.append(make('td', '', request.status), make('td', 'mono number', duration(request.durationMs)));
      return row;
    });
    $('request-body').replaceChildren(...rows);
    $('request-table').hidden = !rows.length;
    $('requests-empty').hidden = rows.length > 0;
    $('request-count').textContent = String(rows.length);
  }
  function render() {
    const running = state.running;
    $('connection-status').textContent = running ? T.running : T.stopped;
    $('connection-status').className = `status-title ${running ? 'online' : ''}`;
    $('connection-detail').textContent = running ? T.runningDetail : T.stoppedDetail;
    $('version').textContent = state.version ? `v${state.version}` : '—';
    $('workspace-name').textContent = state.workspace.name || T.noWorkspace;
    $('workspace-roots').textContent = `${state.workspace.rootCount} ${T.roots}`;
    setPill($('workspace-trust'), state.workspace.trusted ? T.trusted : T.untrusted, state.workspace.trusted);
    $('endpoint-value').textContent = state.url || T.offline;
    const primary = $('primary-action');
    primary.textContent = running ? T.stop : T.start;
    primary.dataset.action = running ? 'stop' : 'start';
    primary.disabled = !running && (!state.workspace.trusted || !state.workspace.rootCount);
    $('copy-connection').disabled = !running;
    $('manage-access').disabled = !running;
    for (const capability of ['read', 'edit', 'terminal']) {
      const enabled = running && state.access[capability];
      setPill($(`access-${capability}`), enabled ? T.enabled : T.locked, enabled);
      $(`access-card-${capability}`).classList.toggle('access-on', enabled);
    }
    $('error-notice').hidden = !state.lastError;
    $('error-code').textContent = state.lastError || '';
    renderTools(); renderTasks(); renderRequests();
    $('content').hidden = false; $('loading').hidden = true;
  }
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => sendAction(button.dataset.action)));
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'ready' }));
  $('tool-search').addEventListener('input', renderTools);
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    renderTools();
  }));
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'state' && message.state && Array.isArray(message.state.tools) && Array.isArray(message.state.tasks) && Array.isArray(message.state.recentRequests)) {
      state = message.state; render();
      $('announcement').textContent = T.updated;
    } else if (message.type === 'actionResult' && typeof message.ok === 'boolean') {
      pending = Math.max(0, pending - 1); document.body.classList.toggle('busy', pending > 0);
      $('announcement').textContent = message.ok ? T.updated : T.failed;
    }
  });
  vscode.postMessage({ type: 'ready' });
}

function createDashboardHtml(language, nonce) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) throw new TypeError('A fresh script nonce is required.');
  const zh = /^zh(?:-|$)/i.test(language || '');
  const T = zh ? ZH : EN;
  const tr = key => escapeHtml(T[key]);
  return `<!DOCTYPE html>
<html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none';">
<title>${tr('title')}</title><style nonce="${nonce}">
:root{color-scheme:light dark;--surface:var(--vscode-editor-background);--panel:var(--vscode-sideBar-background,var(--surface));--border:var(--vscode-panel-border,var(--vscode-widget-border));--muted:var(--vscode-descriptionForeground);--accent:var(--vscode-focusBorder);--positive:var(--vscode-testing-iconPassed,var(--vscode-charts-green));}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--vscode-foreground);font:var(--vscode-font-size)/1.55 var(--vscode-font-family);padding:36px 32px 48px}button,input{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.5}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}button:active:not(:disabled){transform:translateY(1px)}[hidden]{display:none!important}h1,h2,h3,p{margin:0}h1{font-size:26px;font-weight:600;letter-spacing:-.6px;line-height:1.2}h2{font-size:17px;font-weight:600;letter-spacing:-.2px}h3{font-size:13px;font-weight:600}code,.mono{font-family:var(--vscode-editor-font-family);font-size:12px}code{overflow-wrap:anywhere}.shell{max-width:1140px;margin:auto}.masthead{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:28px}.brand{display:flex;align-items:center;gap:14px}.mark{width:42px;height:42px;display:grid;place-items:center;border:1px solid var(--accent);color:var(--vscode-foreground);font:600 17px var(--vscode-editor-font-family);border-radius:8px;background:var(--panel)}.subtitle{color:var(--muted);font-size:12px;margin-top:5px}.masthead-meta{display:flex;gap:12px;align-items:center;color:var(--muted)}.eyebrow{font-size:10px;font-weight:600;letter-spacing:1.8px}.version{font:12px var(--vscode-editor-font-family);padding-left:12px;border-left:1px solid var(--border)}.button{padding:8px 13px;border:1px solid transparent;border-radius:4px;font-size:12px;font-weight:500;line-height:1.4;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.button:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}.button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-color:var(--vscode-contrastBorder,transparent)}.button.secondary:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}.button.quiet{color:var(--vscode-foreground);background:transparent;border-color:var(--border)}.button.quiet:hover{background:var(--vscode-toolbar-hoverBackground)}.button.compact{padding:5px 10px}.hero{border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--panel)}.hero-main{display:flex;gap:24px;justify-content:space-between;align-items:center;padding:25px 26px}.status-title{font-size:24px;font-weight:500;letter-spacing:-.5px;display:flex;gap:10px;align-items:center;line-height:1.3}.status-title:before{content:"";width:9px;height:9px;background:var(--vscode-disabledForeground);border-radius:50%;flex-shrink:0}.status-title.online:before{background:var(--positive);box-shadow:0 0 0 4px color-mix(in srgb,var(--positive) 12%,transparent)}.hero .eyebrow{color:var(--muted);margin-bottom:9px}.hero-detail{color:var(--muted);margin-top:8px;max-width:580px;font-size:12px}.hero-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}.connection-grid{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--border)}.connection-cell{padding:18px 26px;min-width:0}.connection-cell+.connection-cell{border-left:1px solid var(--border)}.field-label{font-size:11px;color:var(--muted);margin-bottom:6px}.field-value{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.field-value strong{font-size:13px;font-weight:500;overflow-wrap:anywhere}.field-sub{color:var(--muted);font-size:11px}.endpoint{user-select:all;display:block;overflow-wrap:anywhere}.pill{font-size:10px;line-height:1.2;padding:4px 7px;display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:4px;white-space:nowrap}.pill.positive{color:var(--positive);border-color:color-mix(in srgb,var(--positive) 50%,transparent);background:color-mix(in srgb,var(--positive) 7%,transparent)}.muted{color:var(--muted)}.positive-text{color:var(--positive)}.access-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0 11px}.access-card{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 17px;border:1px solid var(--border);border-radius:6px}.access-title{font-size:13px;font-weight:500}.access-caption{font-size:10px;color:var(--muted);margin-top:2px}.access-on{border-color:color-mix(in srgb,var(--positive) 40%,var(--border))}.utility{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:32px}.utility .button{font-size:11px}.utility .spacer{flex:1}.section{margin:30px 0}.section-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:15px}.section-description{font-size:12px;color:var(--muted);margin-top:5px}.section-title{display:flex;align-items:center;gap:9px}.count{font:11px var(--vscode-editor-font-family);color:var(--muted);padding:2px 6px;background:var(--panel);border:1px solid var(--border);border-radius:4px}.tool-controls{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:20px}.search{position:relative;flex:1;min-width:210px;max-width:450px}.search input{width:100%;padding:9px 11px;border:1px solid var(--vscode-input-border,var(--border));border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:12px}.search input::placeholder{color:var(--vscode-input-placeholderForeground)}.filters{display:flex;gap:4px}.filter{border:1px solid transparent;border-radius:4px;padding:6px 10px;background:transparent;color:var(--muted);font-size:11px}.filter:hover{color:var(--vscode-foreground);background:var(--vscode-toolbar-hoverBackground)}.filter[aria-pressed=true]{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);border-color:var(--vscode-contrastActiveBorder,transparent)}.group-heading{display:flex;gap:8px;align-items:center;margin-bottom:10px}.tool-group+.tool-group{margin-top:22px}.tool-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.tool-card{border:1px solid var(--border);border-radius:6px;padding:15px 16px;display:flex;flex-direction:column;gap:8px;min-width:0}.tool-top{display:flex;gap:10px;align-items:flex-start;justify-content:space-between}.tool-name{font-size:12px;font-weight:600}.tool-availability{font-size:10px;white-space:nowrap;color:var(--muted)}.tool-availability.positive-text{color:var(--positive)}.tool-card p{font-size:12px;color:var(--muted);line-height:1.5}.tool-category{font-size:10px;color:var(--muted);margin-top:auto}.tool-locked .tool-name{color:var(--muted)}.list-box{border:1px solid var(--border);border-radius:6px;overflow:hidden}.empty{padding:22px 18px;color:var(--muted);font-size:12px;text-align:center}.task-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:15px 18px}.task-row+.task-row{border-top:1px solid var(--border)}.task-detail{min-width:0}.task-detail strong{font-size:12px;font-weight:500}.task-meta{display:flex;gap:6px 14px;flex-wrap:wrap;color:var(--muted);font-size:10px;margin-top:5px}.task-meta code{font-size:10px}.task-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}th{font-size:10px;font-weight:500;color:var(--muted);background:var(--panel);padding:10px 16px}td{padding:10px 16px;border-top:1px solid var(--border)}td.number{text-align:right;white-space:nowrap}th:last-child{text-align:right}.security-section{border-top:1px solid var(--border);padding-top:26px;margin-top:34px}.security-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px;margin-top:18px}.security-item{position:relative;padding-left:14px;border-left:2px solid var(--border)}.security-item h3{font-size:12px;margin-bottom:7px}.security-item p{font-size:11px;color:var(--muted)}.notice{margin-top:15px;padding:10px 14px;border:1px solid var(--vscode-inputValidation-warningBorder,var(--border));background:var(--vscode-inputValidation-warningBackground);font-size:12px;display:flex;gap:10px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.busy [data-action]:not([data-action="stop"]){pointer-events:none;opacity:.6}body.vscode-high-contrast .pill,body.vscode-high-contrast-light .pill,body.vscode-high-contrast .access-card,body.vscode-high-contrast-light .access-card{border-color:var(--vscode-contrastBorder)}
@media(min-width:1400px){body{padding-top:48px}.hero-main{padding:30px}.connection-cell{padding:20px 30px}}@media(max-width:760px){body{padding:22px 18px 36px}.masthead{align-items:flex-start}.eyebrow{letter-spacing:1px}.hero-main{align-items:flex-start;flex-direction:column;padding:22px}.hero-actions{justify-content:flex-start}.connection-grid{grid-template-columns:1fr}.connection-cell{padding:16px 22px}.connection-cell+.connection-cell{border-left:0;border-top:1px solid var(--border)}.tool-grid{grid-template-columns:1fr}.security-grid{grid-template-columns:1fr;gap:17px}.task-row{align-items:flex-start;flex-direction:column}.task-actions{align-self:flex-end}.status-title{font-size:22px}.access-grid{gap:7px}.access-card{padding:12px;align-items:flex-start;flex-direction:column;gap:8px}.section-heading{align-items:flex-start}.utility{margin-bottom:24px}}@media(max-width:420px){.masthead-meta .eyebrow{display:none}h1{font-size:22px}.mark{width:36px;height:36px}.filters{width:100%;justify-content:space-between}.filter{padding:6px 8px}.hero-actions{width:100%}.hero-actions .button{flex:1}.access-caption{display:none}td,th{padding-left:10px;padding-right:10px}}
</style></head><body><div class="shell">
<header class="masthead"><div class="brand"><div class="mark" aria-hidden="true">[↔]</div><div><h1>${tr('title')}</h1><p class="subtitle">${tr('subtitle')}</p></div></div><div class="masthead-meta"><span class="eyebrow">${tr('local')}</span><span class="version" id="version" aria-label="${tr('version')}">—</span></div></header>
<p id="loading" class="empty" role="status">${tr('loading')}</p><main id="content" hidden>
<section class="hero" aria-labelledby="connection-status"><div class="hero-main"><div><div class="eyebrow">${tr('overview')}</div><h2 class="status-title" id="connection-status"></h2><p id="connection-detail" class="hero-detail"></p></div><div class="hero-actions"><button type="button" class="button" id="primary-action" data-action="start">${tr('start')}</button><button type="button" class="button secondary" id="copy-connection" data-action="copyConnection">${tr('copyConnection')}</button></div></div><div class="connection-grid"><div class="connection-cell"><p class="field-label">${tr('workspace')}</p><div class="field-value"><strong id="workspace-name"></strong><span class="pill" id="workspace-trust"></span></div><p id="workspace-roots" class="field-sub"></p></div><div class="connection-cell"><p class="field-label">${tr('endpoint')}</p><code id="endpoint-value" class="endpoint"></code></div></div></section>
<div class="access-grid">${['read', 'edit', 'terminal'].map(capability => `<div class="access-card" id="access-card-${capability}"><div><p class="access-title">${tr(capability)}</p><p class="access-caption">${tr('session')}</p></div><span class="pill" id="access-${capability}"></span></div>`).join('')}</div>
<div class="utility" role="group" aria-label="${tr('quickActions')}"><button type="button" class="button quiet" id="manage-access" data-action="access">${tr('access')}</button><button type="button" class="button quiet" data-action="copyPrompt">${tr('copyPrompt')}</button><span class="spacer"></span><button type="button" class="button quiet" data-action="rotateToken">${tr('rotateToken')}</button><button type="button" class="button quiet" data-action="exportDiagnostics">${tr('exportDiagnostics')}</button><button type="button" class="button quiet" id="refresh">${tr('refresh')}</button></div>
<div class="notice" id="error-notice" hidden><span>${tr('error')}</span><code id="error-code"></code></div>
<section class="section" aria-labelledby="tools-title"><div class="section-heading"><div><h2 id="tools-title">${tr('tools')}</h2><p class="section-description">${tr('toolsHint')}</p></div><span id="tool-count" class="count">0</span></div><div class="tool-controls"><label class="search"><span class="sr-only">${tr('search')}</span><input type="search" id="tool-search" maxlength="200" autocomplete="off" spellcheck="false" placeholder="${tr('search')}"></label><div class="filters" role="group" aria-label="${tr('tools')}">${['all', 'read', 'edit', 'terminal'].map(capability => `<button type="button" class="filter" data-filter="${capability}" aria-pressed="${capability === 'all'}">${tr(capability === 'all' ? 'all' : capability)}</button>`).join('')}</div></div><div id="tool-list"></div></section>
<section class="section" aria-labelledby="tasks-title"><div class="section-heading"><div><div class="section-title"><h2 id="tasks-title">${tr('tasks')}</h2><span class="count" id="task-count">0</span></div><p class="section-description">${tr('tasksHint')}</p></div></div><div class="list-box" id="task-list"></div></section>
<section class="section" aria-labelledby="requests-title"><div class="section-heading"><div><div class="section-title"><h2 id="requests-title">${tr('requests')}</h2><span class="count" id="request-count">0</span></div><p class="section-description">${tr('requestsHint')}</p></div></div><div class="list-box table-scroll"><table id="request-table"><thead><tr><th scope="col">${tr('time')}</th><th scope="col">${tr('tool')}</th><th scope="col">${tr('status')}</th><th scope="col">${tr('duration')}</th></tr></thead><tbody id="request-body"></tbody></table><p id="requests-empty" class="empty">${tr('noRequests')}</p></div></section>
<section class="security-section" aria-labelledby="security-title"><h2 id="security-title">${tr('security')}</h2><p class="section-description">${tr('securityHint')}</p><div class="security-grid">${['local', 'session', 'terminal'].map(key => `<div class="security-item"><h3>${tr(key + 'Title')}</h3><p>${tr(key + 'Text')}</p></div>`).join('')}</div></section>
</main><div id="announcement" class="sr-only" aria-live="polite" aria-atomic="true"></div></div>
<script nonce="${nonce}">(${dashboardClient.toString()})(${JSON.stringify(T).replace(/</g, '\\u003c')});</script></body></html>`;
}

function createDashboard({ vscode, context, getState, onAction }) {
  if (!vscode || !context || typeof getState !== 'function' || typeof onAction !== 'function') throw new TypeError('Dashboard dependencies are required.');
  let panel;
  let disposed = false;
  let generation = 0;
  const pendingActions = new Set();
  let panelSubscriptions = [];
  const clearSubscriptions = () => {
    for (const subscription of panelSubscriptions.splice(0)) subscription.dispose();
  };
  async function update() {
    if (disposed || !panel) return;
    const target = panel;
    const revision = ++generation;
    let state;
    try { state = sanitizeDashboardState(await getState()); }
    catch { state = sanitizeDashboardState({ lastError: 'STATE_UNAVAILABLE' }); }
    if (disposed || panel !== target || revision !== generation) return;
    try { await target.webview.postMessage({ type: 'state', state }); } catch { /* The editor can close while posting. */ }
  }
  async function receive(raw) {
    const message = validateDashboardMessage(raw);
    if (!message || disposed || !panel) return;
    if (message.type === 'ready') { await update(); return; }
    const target = panel;
    const actionKey = message.action === 'cancelTask' ? `cancelTask:${message.payload.id}` : message.action;
    const urgent = message.action === 'stop' || message.action === 'cancelTask';
    if (pendingActions.has(actionKey) || (pendingActions.size && !urgent)) {
      try { await target.webview.postMessage({ type: 'actionResult', ok: false }); } catch { /* Closed panel. */ }
      return;
    }
    pendingActions.add(actionKey);
    let ok = true;
    try {
      // Recheck ownership and liveness against the host, never against browser state.
      if (message.action === 'cancelTask') {
        const state = sanitizeDashboardState(await getState());
        if (!state.tasks.some(task => task.id === message.payload.id && ACTIVE_STATUSES.has(task.status))) throw new Error('Task unavailable');
      }
      if (disposed || panel !== target) return;
      await onAction(message.action, message.payload);
    } catch { ok = false; }
    finally {
      pendingActions.delete(actionKey);
      if (!disposed && panel === target) {
        try { await target.webview.postMessage({ type: 'actionResult', ok }); } catch { /* Closed panel. */ }
        await update();
      }
    }
  }
  function open() {
    if (disposed) return;
    if (panel) { panel.reveal(vscode.ViewColumn.Active); void update(); return panel; }
    const T = /^zh(?:-|$)/i.test(vscode.env.language || '') ? ZH : EN;
    panel = vscode.window.createWebviewPanel('workspaceBridge.dashboard', T.title, vscode.ViewColumn.Active, {
      enableScripts: true, enableCommandUris: false, retainContextWhenHidden: false, localResourceRoots: [],
    });
    const created = panel;
    panelSubscriptions = [
      created.webview.onDidReceiveMessage(raw => { void receive(raw); }),
      created.onDidDispose(() => {
        if (panel !== created) return;
        panel = undefined; generation++; clearSubscriptions();
      }),
      created.onDidChangeViewState(event => { if (event.webviewPanel.visible) void update(); }),
    ];
    created.webview.html = createDashboardHtml(vscode.env.language, crypto.randomBytes(16).toString('hex'));
    void update();
    return created;
  }
  function dispose() {
    if (disposed) return;
    disposed = true; generation++;
    const previous = panel; panel = undefined;
    clearSubscriptions(); previous?.dispose();
  }
  return { open, update, dispose };
}

module.exports = { createDashboard, createDashboardHtml, sanitizeDashboardState, validateDashboardMessage };
