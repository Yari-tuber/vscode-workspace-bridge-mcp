'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const defaultSecurity = require('./security');
const { createTaskManager, safeTaskEnvironment } = require('./task-manager');
const { createWorkspaceOps } = require('./workspace-ops');
const { CAPABILITIES } = require('./permission-lease');
const { createRefactorOps } = require('./refactor-ops');
const { createProjectTasks } = require('./project-tasks');

const MAX_OUTPUT_BYTES = 64_000;
const MAX_COMMAND_LENGTH = 8_192;

function safeEnvironment(source = process.env) {
  return safeTaskEnvironment(source);
}

function createVscodeHost({ vscode, getAccess, audit = () => {}, onTaskChange = () => {}, security = defaultSecurity, approvalTimeoutMs = 30_000, languageTimeoutMs = 10_000 }) {
  const { BridgeError, assertWorkspace, resolvePath, assertSafeContent, toRelative, hashText } = security;
  let epoch = crypto.randomBytes(16).toString('hex');
  let rootBindings;
  let taskManager;
  let projectManager;
  const children = new Set();
  const pendingApprovals = new Set();
  const fileLocks = new Map();
  const previews = new Map();
  const approvedProjectTasks = new Set();
  const providerTimeoutMs = Number.isInteger(languageTimeoutMs) && languageTimeoutMs > 0 ? Math.min(languageTimeoutMs, 30_000) : 10_000;
  const scheme = `workspace-bridge-preview-${crypto.randomBytes(6).toString('hex')}`;
  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) { return previews.get(uri.toString()) || ''; },
  });
  const zh = () => /^zh(?:-|$)/i.test(vscode.env.language || '');
  const localized = (en, cn) => zh() ? cn : en;

  function fail(code, message) { throw new BridgeError(code, message); }
  function rootIdentity(sourcePath) {
    const canonical = fsSync.realpathSync.native(sourcePath);
    const stat = fsSync.statSync(canonical, { bigint: true });
    if (!stat.isDirectory()) throw new Error('Workspace root is not a directory');
    return { canonical, identity: `${stat.dev}:${stat.ino}` };
  }
  function getWorkspace() {
    const folders = vscode.workspace.workspaceFolders || [];
    const localFolders = folders.filter(folder => folder.uri.scheme === 'file');
    if (!rootBindings) rootBindings = localFolders.map(folder => {
      const sourcePath = path.resolve(folder.uri.fsPath);
      try { return { sourcePath, ...rootIdentity(sourcePath) }; } catch { return { sourcePath, canonical: undefined, identity: undefined }; }
    });
    let unchanged = rootBindings.length === localFolders.length;
    const roots = localFolders.map((folder, index) => {
      const binding = rootBindings[index];
      const sourcePath = path.resolve(folder.uri.fsPath);
      if (!binding || sourcePath !== binding.sourcePath || !binding.canonical) unchanged = false;
      else {
        try {
          const current = rootIdentity(sourcePath);
          if (current.canonical !== binding.canonical || current.identity !== binding.identity) unchanged = false;
        } catch { unchanged = false; }
      }
      return { name: folder.name, path: binding?.canonical || sourcePath };
    });
    return {
      id: epoch,
      name: vscode.workspace.name || roots.map(root => root.name).join(', ') || 'Workspace',
      roots,
      trusted: vscode.workspace.isTrusted === true && roots.length === folders.length && unchanged,
    };
  }

  function killChild(child) {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR;
      if (!systemRoot) { try { child.kill(); } catch {} return; }
      const killer = childProcess.spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', env: safeEnvironment(),
      });
      killer.on('error', () => { try { child.kill(); } catch {} });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }
  }

  function resetSession() {
    approvedProjectTasks.clear();
    taskManager?.cancelAll({ clear: true });
    projectManager?.cancelAll({ clear: true });
    host.clearRefactorPlans?.();
    epoch = crypto.randomBytes(16).toString('hex');
    rootBindings = undefined;
    previews.clear();
    for (const cancel of pendingApprovals) cancel();
    pendingApprovals.clear();
    for (const child of children) killChild(child);
    const tabs = (vscode.window.tabGroups?.all || []).flatMap(group => group.tabs).filter(tab =>
      tab.input?.modified?.scheme === scheme || tab.input?.uri?.scheme === scheme);
    if (tabs.length) Promise.resolve(vscode.window.tabGroups.close(tabs, true)).catch(() => {});
  }
  function cancelTerminal() {
    approvedProjectTasks.clear();
    taskManager?.cancelAll({ clear: false });
    projectManager?.cancelAll({ clear: false });
    for (const cancel of pendingApprovals) cancel();
    pendingApprovals.clear();
    for (const child of children) killChild(child);
  }

  function snapshot(workspaceId, capability = 'read') {
    if (typeof workspaceId !== 'string' || !workspaceId) fail('WORKSPACE_REQUIRED', 'Pass the workspaceId from workspace_overview.');
    const workspace = getWorkspace();
    assertWorkspace(host, workspaceId, { capability });
    return workspace;
  }

  function recheck(workspace, capability = 'read') {
    assertWorkspace(host, workspace.id, { capability });
  }

  async function checkedPath(workspace, absolutePath, options = {}) {
    if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) fail('INVALID_PATH', 'An absolute workspace path is required.');
    const relative = relativeInput(workspace, absolutePath);
    if (!relative) fail('OUTSIDE_WORKSPACE', 'The requested path is outside this workspace.');
    const canonical = await resolvePath(workspace, relative.path, { ...options, root: relative.root });
    recheck(workspace, options.capability || 'read');
    return canonical;
  }

  function relativeInput(workspace, absolutePath) {
    return toRelative(workspace, absolutePath) || (rootBindings && toRelative({ roots: rootBindings.map(binding => ({ path: binding.sourcePath })) }, absolutePath));
  }

  function fileArgument(input) { return input && input.path; }
  function redactPaths(text, workspace) {
    let redacted = String(text);
    const redactionRoots = [...workspace.roots, ...(rootBindings || []).map(binding => ({ path: binding.sourcePath }))];
    for (const root of redactionRoots.sort((a, b) => b.path.length - a.path.length)) {
      for (const variant of new Set([root.path, root.path.replaceAll('\\', '/')])) {
        redacted = redacted.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), process.platform === 'win32' ? 'gi' : 'g'), '[workspace]');
      }
    }
    return redacted;
  }
  function rangeValue(range) {
    return range && { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } };
  }

  async function readForWorkspace(workspace, inputPath, capability = 'read') {
    const absolutePath = await checkedPath(workspace, inputPath, { capability });
    const stat = await fs.stat(absolutePath);
    recheck(workspace, capability);
    if (stat.size > 512 * 1024) fail('FILE_TOO_LARGE', 'Files must be at most 512 KiB.');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
    await checkedPath(workspace, absolutePath, { capability });
    const text = document.getText();
    if (Buffer.byteLength(text, 'utf8') > 512 * 1024) fail('FILE_TOO_LARGE', 'The editor buffer is too large.');
    assertSafeContent(text);
    return { text, version: document.version, languageId: document.languageId, isDirty: document.isDirty };
  }

  async function readDocument(input) {
    return readForWorkspace(snapshot(input?.workspaceId), fileArgument(input));
  }

  async function ensureAbsent(absolutePath) {
    try { await fs.lstat(absolutePath); } catch (error) {
      if (error.code === 'ENOENT') return;
      fail('PATH_UNAVAILABLE', 'The target cannot be accessed.');
    }
    fail('FILE_EXISTS', 'The file already exists. Read its current content before editing.');
  }

  function lockKey(absolutePath) {
    const normalized = path.normalize(absolutePath);
    // Also serialize case aliases on default macOS volumes. Extra serialization
    // of distinct Linux names is harmless; bypassing an edit lock is not.
    return normalized.toLowerCase();
  }

  async function withFileLock(absolutePath, operation) {
    const key = lockKey(absolutePath);
    const previous = fileLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    fileLocks.set(key, current);
    await previous;
    try { return await operation(); } finally {
      release();
      if (fileLocks.get(key) === current) fileLocks.delete(key);
    }
  }

  async function applyEdit({ path: inputPath, text, expectedVersion, expectedHash, workspaceId }) {
    const workspace = snapshot(workspaceId, 'edit');
    if (typeof text !== 'string') fail('INVALID_ARGUMENT', 'Replacement text must be a string.');
    assertSafeContent(text);
    const creating = expectedHash === 'new';
    if (!creating && (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))) fail('EXPECTED_HASH_REQUIRED', 'Pass the current file hash, or new for an absent file.');
    const absolutePath = await checkedPath(workspace, inputPath, { capability: 'edit', create: creating });
    return withFileLock(absolutePath, async () => {
      const lockedWorkspace = snapshot(workspaceId, 'edit');
      const lockedPath = await checkedPath(lockedWorkspace, inputPath, { capability: 'edit', create: creating });
      if (lockKey(lockedPath) !== lockKey(absolutePath)) fail('PATH_CHANGED', 'The path changed while waiting. Read it again before editing.');
      return applyLockedEdit(lockedWorkspace, lockedPath, { text, expectedVersion, expectedHash, creating });
    });
  }

  async function applyLockedEdit(workspace, absolutePath, { text, expectedVersion, expectedHash, creating }) {
    const uri = vscode.Uri.file(absolutePath);
    let document;
    const edit = new vscode.WorkspaceEdit();
    if (creating) {
      await ensureAbsent(absolutePath);
      recheck(workspace, 'edit');
      if ((vscode.workspace.textDocuments || []).some(doc => doc.uri.toString() === uri.toString() && doc.isDirty)) fail('UNSAVED_CHANGES', 'An unsaved editor already uses this file name. Review it locally first.');
      edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
      edit.insert(uri, new vscode.Position(0, 0), text);
    } else {
      document = await vscode.workspace.openTextDocument(uri);
      await checkedPath(workspace, absolutePath, { capability: 'edit' });
      const before = document.getText();
      assertSafeContent(before);
      if (hashText(before) !== expectedHash || (expectedVersion !== undefined && document.version !== expectedVersion)) fail('EDIT_CONFLICT', 'The document changed. Read it again before applying edits.');
      if (document.isDirty && expectedVersion === undefined) fail('UNSAVED_CHANGES', 'Read the current unsaved document before applying edits.');
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(before.length)), text);
    }
    await checkedPath(workspace, absolutePath, { capability: 'edit', create: creating });
    const applied = await vscode.workspace.applyEdit(edit);
    await checkedPath(workspace, absolutePath, { capability: 'edit' });
    if (!applied) fail('EDIT_FAILED', 'VS Code could not apply the edit.');
    if (!document) document = await vscode.workspace.openTextDocument(uri);
    await checkedPath(workspace, absolutePath, { capability: 'edit' });
    const saved = await document.save();
    await checkedPath(workspace, absolutePath, { capability: 'edit' });
    if (!saved) fail('SAVE_FAILED', 'The edit is visible in VS Code but could not be saved. Review the open document.');
    const actualText = document.getText();
    assertSafeContent(actualText);
    const eol = (document.eol !== undefined && document.eol === vscode.EndOfLine?.CRLF) || actualText.includes('\r\n') ? 'CRLF' : 'LF';
    return { applied: true, saved: true, version: document.version, hash: hashText(actualText), eol };
  }

  async function getDiagnostics(input = {}) {
    const workspace = snapshot(input.workspaceId);
    const targetPath = fileArgument(input);
    const entries = targetPath
      ? [[vscode.Uri.file(await checkedPath(workspace, targetPath)), null]]
      : vscode.languages.getDiagnostics();
    const result = [];
    for (const [uri, supplied] of entries) {
      if (uri.scheme !== 'file' || !relativeInput(workspace, uri.fsPath)) continue;
      let absolutePath;
      try { absolutePath = await checkedPath(workspace, uri.fsPath); } catch (error) {
        recheck(workspace);
        if (targetPath) throw error;
        continue;
      }
      for (const diagnostic of supplied || vscode.languages.getDiagnostics(uri)) {
        const message = redactPaths(diagnostic.message, workspace);
        const source = diagnostic.source && redactPaths(diagnostic.source, workspace);
        const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
        assertSafeContent(message);
        if (source) assertSafeContent(source);
        if (typeof code === 'string') assertSafeContent(code);
        result.push({ ...toRelative(workspace, absolutePath), severity: diagnostic.severity, message, source,
          code: typeof code === 'string' ? redactPaths(code, workspace) : code, range: rangeValue(diagnostic.range) });
        if (result.length >= 500) break;
      }
      if (result.length >= 500) break;
    }
    recheck(workspace);
    return result;
  }

  function serializeSymbol(symbol, remaining, workspace) {
    if (remaining.count-- <= 0) return null;
    assertSafeContent(symbol.name);
    if (symbol.detail) assertSafeContent(symbol.detail);
    return { name: redactPaths(symbol.name, workspace), detail: symbol.detail && redactPaths(symbol.detail, workspace), kind: symbol.kind,
      range: rangeValue(symbol.range || (symbol.location && symbol.location.range)), selectionRange: rangeValue(symbol.selectionRange),
      children: (symbol.children || []).map(child => serializeSymbol(child, remaining, workspace)).filter(Boolean) };
  }

  async function getSymbols(input) {
    const workspace = snapshot(input?.workspaceId);
    const absolutePath = await checkedPath(workspace, fileArgument(input));
    await readForWorkspace(workspace, absolutePath);
    recheck(workspace);
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', vscode.Uri.file(absolutePath));
    await checkedPath(workspace, absolutePath);
    const remaining = { count: 500 };
    return (symbols || []).map(symbol => serializeSymbol(symbol, remaining, workspace)).filter(Boolean);
  }

  async function getEditorContext({ workspaceId, includeSelection = false } = {}) {
    const workspace = snapshot(workspaceId);
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    if (!document || document.uri.scheme !== 'file' || !relativeInput(workspace, document.uri.fsPath)) return { active: false };
    const initialVersion = document.version;
    const initialUri = document.uri.toString();
    const primarySelection = editor.selection;
    const selection = rangeValue(primarySelection);
    const allSelections = editor.selections || (editor.selection ? [editor.selection] : []);
    const selections = allSelections.slice(0, 20).map(rangeValue);
    function recheckEditor() {
      recheck(workspace);
      const active = vscode.window.activeTextEditor;
      if (active !== editor || active.document !== document || document.uri.toString() !== initialUri || document.version !== initialVersion) {
        fail('EDITOR_CHANGED', 'The active editor changed. Request its context again.');
      }
    }
    const absolutePath = await checkedPath(workspace, document.uri.fsPath);
    const stat = await fs.stat(absolutePath);
    recheckEditor();
    if (stat.size > 512 * 1024) fail('FILE_TOO_LARGE', 'Files must be at most 512 KiB.');
    const text = document.getText();
    if (Buffer.byteLength(text, 'utf8') > 512 * 1024) fail('FILE_TOO_LARGE', 'The editor buffer is too large.');
    assertSafeContent(text);
    const result = { active: true, ...toRelative(workspace, absolutePath), languageId: document.languageId,
      version: initialVersion, isDirty: document.isDirty, hash: hashText(text), selection,
      selections, selectionCount: allSelections.length, selectionRangesTruncated: allSelections.length > 20 };
    if (includeSelection === true) {
      const selectedText = primarySelection ? document.getText(primarySelection) : '';
      // Inspect the complete selection before truncating: a credential after
      // the returned prefix must not turn an unsafe selection into a safe one.
      assertSafeContent(selectedText);
      result.selectedText = selectedText.slice(0, 8000);
      result.selectionTruncated = selectedText.length > 8000;
    }
    await checkedPath(workspace, absolutePath);
    recheckEditor();
    return result;
  }

  async function getHover({ workspaceId, path: inputPath, line, character }) {
    const workspace = snapshot(workspaceId);
    const absolutePath = await checkedPath(workspace, inputPath);
    if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) fail('INVALID_POSITION', 'Line and character must be non-negative integers.');
    const stat = await fs.stat(absolutePath);
    if (stat.size > 512 * 1024) fail('FILE_TOO_LARGE', 'Files must be at most 512 KiB.');
    const document = await readForWorkspace(workspace, absolutePath);
    if (Buffer.byteLength(document.text, 'utf8') > 512 * 1024) fail('FILE_TOO_LARGE', 'The editor buffer is too large.');
    const lines = document.text.split(/\r\n|\r|\n/);
    if (line >= lines.length || character > lines[line].length) fail('INVALID_POSITION', 'The position is outside the current document.');
    recheck(workspace);
    let timer;
    let supplied;
    try {
      supplied = await Promise.race([
        vscode.commands.executeCommand('vscode.executeHoverProvider', vscode.Uri.file(absolutePath), new vscode.Position(line, character)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new BridgeError('LANGUAGE_TIMEOUT', 'The language service did not respond in time. Retry after it finishes loading.')), providerTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
    await checkedPath(workspace, absolutePath);
    const live = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
    recheck(workspace);
    if (live.version !== document.version) fail('DOCUMENT_CHANGED', 'The document changed while the language service was running. Request its hover again.');
    const hovers = [];
    let remaining = 12000;
    let inspected = 0;
    let truncated = (supplied || []).length > 5;
    for (const hover of (supplied || []).slice(0, 5)) {
      const contents = [];
      const values = Array.isArray(hover.contents) ? hover.contents : [];
      if (values.length > 20) truncated = true;
      for (const content of values.slice(0, 20)) {
        const raw = typeof content === 'string' ? content : content?.value;
        if (typeof raw !== 'string') continue;
        inspected += raw.length;
        if (inspected > 128000) fail('RESULT_TOO_LARGE', 'The language service returned too much text. Try a more specific symbol.');
        assertSafeContent(raw);
        const safe = redactPaths(raw, workspace);
        if (safe.length > remaining) truncated = true;
        if (remaining > 0 && safe.length) contents.push(safe.slice(0, remaining));
        remaining = Math.max(0, remaining - safe.length);
      }
      const range = hover.range?.start && hover.range?.end ? rangeValue(hover.range) : undefined;
      const validRange = range && [range.start, range.end].every(position => Number.isInteger(position.line) && position.line >= 0
        && position.line < lines.length && Number.isInteger(position.character) && position.character >= 0 && position.character <= lines[position.line].length)
        && (range.start.line < range.end.line || (range.start.line === range.end.line && range.start.character <= range.end.character));
      hovers.push({ contents, ...(validRange ? { range } : {}) });
    }
    recheck(workspace);
    return { hovers, truncated, untrusted: true };
  }

  async function languageRequest(operation) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BridgeError('LANGUAGE_TIMEOUT', 'The language service did not respond in time. Retry after it finishes loading.')), providerTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  function validRange(range) {
    if (!range?.start || !range?.end) return false;
    const points = [range.start, range.end];
    return points.every(p => Number.isInteger(p.line) && p.line >= 0 && p.line <= 1000000 && Number.isInteger(p.character) && p.character >= 0 && p.character <= 1000000)
      && (range.start.line < range.end.line || (range.start.line === range.end.line && range.start.character <= range.end.character));
  }

  async function searchWorkspaceSymbols({ workspaceId, query, limit = 50 }) {
    const workspace = snapshot(workspaceId);
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_QUERY', 'Provide a symbol query of 1 to 200 characters and a limit of 1 to 100.');
    assertSafeContent(query);
    const supplied = await languageRequest(() => vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query));
    recheck(workspace);
    if (supplied !== undefined && !Array.isArray(supplied)) fail('INVALID_LANGUAGE_RESULT', 'The language service returned an unsupported result.');
    const symbols = []; let inspected = 0;
    for (const symbol of supplied || []) {
      if (++inspected > 1000 || symbols.length >= limit) break;
      const location = symbol?.location;
      if (!location?.uri || location.uri.scheme !== 'file' || !relativeInput(workspace, location.uri.fsPath) || !validRange(location.range)) continue;
      if (typeof symbol.name !== 'string' || !symbol.name || symbol.name.length > 500) continue;
      assertSafeContent(symbol.name);
      try {
        const absolute = await checkedPath(workspace, location.uri.fsPath);
        symbols.push({ name: redactPaths(symbol.name, workspace), kind: Number.isInteger(symbol.kind) ? symbol.kind : undefined,
          ...toRelative(workspace, absolute), range: rangeValue(location.range) });
      } catch (error) { recheck(workspace); if (error.code === 'ACCESS_DENIED' || error.code === 'WORKSPACE_CHANGED') throw error; }
    }
    recheck(workspace);
    return { symbols, truncated: inspected > 1000 || (symbols.length >= limit && inspected < (supplied || []).length), untrusted: true };
  }

  async function locations(command, { path: inputPath, line, character, workspaceId }) {
    const workspace = snapshot(workspaceId);
    const absolutePath = await checkedPath(workspace, inputPath);
    if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) fail('INVALID_POSITION', 'Line and character must be non-negative integers.');
    const document = await readForWorkspace(workspace, absolutePath);
    const lines = document.text.split(/\r\n|\r|\n/);
    if (line >= lines.length || character > lines[line].length) fail('INVALID_POSITION', 'The position is outside the current document.');
    recheck(workspace);
    const locations = await languageRequest(() => vscode.commands.executeCommand(command, vscode.Uri.file(absolutePath), new vscode.Position(line, character)));
    await checkedPath(workspace, absolutePath);
    const live = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
    recheck(workspace);
    if (live.version !== document.version) fail('DOCUMENT_CHANGED', 'The document changed while the language service was running. Request its locations again.');
    if (locations !== undefined && !Array.isArray(locations)) fail('INVALID_LANGUAGE_RESULT', 'The language service returned an unsupported result.');
    const result = [];
    for (const location of (locations || []).slice(0, 200)) {
      if (!location || typeof location !== 'object') continue;
      const uri = location.targetUri || location.uri;
      const range = location.targetSelectionRange || location.targetRange || location.range;
      if (!uri || uri.scheme !== 'file' || !relativeInput(workspace, uri.fsPath) || !validRange(range)) continue;
      try {
        const targetPath = await checkedPath(workspace, uri.fsPath);
        result.push({ ...toRelative(workspace, targetPath), range: rangeValue(range) });
      } catch { recheck(workspace); }
    }
    recheck(workspace);
    if (live.version !== document.version) fail('DOCUMENT_CHANGED', 'The document changed while resolving its locations. Request them again.');
    return result;
  }

  async function previewDiff({ path: inputPath, text, workspaceId, expectedHash, expectedVersion, capability = 'edit' }) {
    if (!['edit', 'refactor'].includes(capability)) fail('ACCESS_DENIED', 'Invalid preview capability.');
    const workspace = snapshot(workspaceId, capability);
    assertSafeContent(text);
    const creating = expectedHash === 'new';
    const absolutePath = await checkedPath(workspace, inputPath, { create: creating, capability });
    let original = vscode.Uri.file(absolutePath);
    if (creating) {
      await ensureAbsent(absolutePath);
      original = vscode.Uri.parse(`${scheme}:/empty-${crypto.randomBytes(8).toString('hex')}`);
      previews.set(original.toString(), '');
    } else {
      const current = await readForWorkspace(workspace, absolutePath, capability);
      if (hashText(current.text) !== expectedHash || (expectedVersion !== undefined && current.version !== expectedVersion)) fail('EDIT_CONFLICT', 'The document changed. Read it again before previewing edits.');
    }
    recheck(workspace, capability);
    const uri = vscode.Uri.parse(`${scheme}:/proposal-${crypto.randomBytes(8).toString('hex')}/${encodeURIComponent(path.basename(absolutePath))}`);
    previews.set(uri.toString(), text);
    while (previews.size > 20) previews.delete(previews.keys().next().value);
    await checkedPath(workspace, absolutePath, { create: creating, capability });
    await vscode.commands.executeCommand('vscode.diff', original, uri,
      localized(`Proposed changes: ${path.basename(absolutePath)}`, `建议修改：${path.basename(absolutePath)}`), { preview: true });
    await checkedPath(workspace, absolutePath, { create: creating, capability });
    return { opened: true };
  }

  async function showDocument({ path: inputPath, line, workspaceId }) {
    const workspace = snapshot(workspaceId);
    const absolutePath = await checkedPath(workspace, inputPath);
    await readForWorkspace(workspace, absolutePath);
    recheck(workspace);
    const options = { preview: true };
    if (Number.isInteger(line) && line >= 0) options.selection = new vscode.Range(line, 0, line, 0);
    await checkedPath(workspace, absolutePath);
    await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), options);
    await checkedPath(workspace, absolutePath);
    return { opened: true };
  }

  function validateCommand(command) {
    if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_LENGTH || command.includes('\0')) fail('INVALID_COMMAND', 'Provide a command of 1 to 8192 characters.');
    assertSafeContent(command);
    if (/(?:^|[\s"'`/\\])(?:\.env(?:\.[\w.-]+)?|\.ssh|\.aws|\.azure|\.gnupg|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?(?:\.(?:json|ya?ml|toml))?)(?=$|[\s"'`/\\;|&])/i.test(command)) {
      fail('SENSITIVE_COMMAND', 'Commands targeting credential files are not allowed.');
    }
  }

  async function confirmTerminal({ command, cwd, workspaceId }) {
    const workspace = snapshot(workspaceId, 'terminal');
    validateCommand(command);
    const absolutePath = await checkedPath(workspace, cwd, { directory: true, capability: 'terminal' });
    recheck(workspace, 'terminal');
    const approve = localized('Run once', '仅运行这一次');
    let timer;
    let cancel;
    try {
      const answer = await Promise.race([
        vscode.window.showWarningMessage(localized('Run this external terminal command?', '运行这条外部终端命令？'), {
          modal: true,
          detail: localized('This runs with your user permissions. It can access files outside this workspace and use the network. Approval expires in 30 seconds.',
            '此命令以你的用户权限运行，可以访问工作区之外的文件和网络。本次确认 30 秒后失效。') + `\n\n${absolutePath}\n\n${command}`,
        }, approve),
        new Promise(resolve => { timer = setTimeout(() => resolve(undefined), approvalTimeoutMs); }),
        new Promise(resolve => { cancel = () => resolve(undefined); pendingApprovals.add(cancel); }),
      ]);
      recheck(workspace, 'terminal');
      return answer === approve;
    } finally { clearTimeout(timer); pendingApprovals.delete(cancel); }
  }

  async function confirmAction({ workspaceId, capability, title, detail }) {
    if (!['git', 'tasks', 'refactor'].includes(capability)) fail('ACCESS_DENIED', 'This action requires a specific local capability.');
    const workspace = snapshot(workspaceId, capability);
    if (typeof title !== 'string' || title.length > 250 || typeof detail !== 'string' || detail.length > 12000) fail('INVALID_ARGUMENT', 'Invalid local approval details.');
    assertSafeContent(title); assertSafeContent(detail);
    const approve = localized('Approve once', '仅批准这一次');
    let timer, cancel;
    try {
      const answer = await Promise.race([
        vscode.window.showWarningMessage(title, { modal: true, detail }, approve),
        new Promise(resolve => { timer = setTimeout(() => resolve(undefined), approvalTimeoutMs); }),
        new Promise(resolve => { cancel = () => resolve(undefined); pendingApprovals.add(cancel); }),
      ]);
      recheck(workspace, capability);
      return answer === approve;
    } finally { clearTimeout(timer); pendingApprovals.delete(cancel); }
  }

  async function confirmProjectTask({ workspaceId, cwd, command, approval }) {
    const workspace = snapshot(workspaceId, 'tasks');
    if (approval?.kind !== 'project_task') fail('INVALID_TASK', 'A manifest-bound project task is required.');
    const absolute = await checkedPath(workspace, cwd, { directory: true, capability: 'tasks' });
    const key = hashText(JSON.stringify([workspaceId, absolute, command, approval]));
    if (approvedProjectTasks.has(key)) return true;
    const once = localized('Run once', '仅运行这一次');
    const session = localized('Allow this task for this session', '本会话允许相同任务');
    const scripts = [{ name: approval.taskName, script: approval.script }, ...(approval.lifecycleScripts || [])];
    const detail = localized('This executes project code with your account permissions, including filesystem and network access. Session approval also permits changed project source to run. Changing package.json requires a new approval. This is not a sandbox.',
      '此操作以你的账户权限执行项目代码，可访问文件和网络。会话授权也允许执行修改后的项目源码；package.json 变化后需重新确认。此执行不在沙箱中。') +
      `\n\n${absolute}\n${command}\n\n` + scripts.map(item => `${item.name}: ${item.script}`).join('\n');
    assertSafeContent(detail);
    let timer, cancel;
    try {
      const answer = await Promise.race([
        vscode.window.showWarningMessage(localized(`Run project task: ${approval.taskName}?`, `运行项目任务：${approval.taskName}？`), { modal: true, detail }, once, session),
        new Promise(resolve => { timer = setTimeout(() => resolve(undefined), approvalTimeoutMs); }),
        new Promise(resolve => { cancel = () => resolve(undefined); pendingApprovals.add(cancel); }),
      ]);
      await checkedPath(workspace, absolute, { directory: true, capability: 'tasks' });
      if (answer === session) {
        if (approvedProjectTasks.size >= 100) approvedProjectTasks.delete(approvedProjectTasks.values().next().value);
        approvedProjectTasks.add(key);
      }
      return answer === once || answer === session;
    } finally { clearTimeout(timer); pendingApprovals.delete(cancel); }
  }

  async function executeTerminal({ command, cwd, timeoutMs = 30_000, workspaceId }) {
    const workspace = snapshot(workspaceId, 'terminal');
    validateCommand(command);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('INVALID_TIMEOUT', 'Command timeout must be between 1 and 30000 milliseconds.');
    const absolutePath = await checkedPath(workspace, cwd, { directory: true, capability: 'terminal' });
    if (!await confirmTerminal({ command, cwd: absolutePath, workspaceId })) fail('APPROVAL_DENIED', 'The local user did not approve this command.');
    await checkedPath(workspace, absolutePath, { directory: true, capability: 'terminal' });
    validateCommand(command);
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      let bytes = 0;
      let timedOut = false;
      let truncated = false;
      const stdout = [];
      const stderr = [];
      const child = childProcess.spawn(command, [], {
        cwd: absolutePath, shell: true, windowsHide: true, env: safeEnvironment(),
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      const timer = setTimeout(() => { timedOut = true; killChild(child); }, timeoutMs);
      const collect = target => chunk => {
        const buffer = Buffer.from(chunk);
        const remaining = MAX_OUTPUT_BYTES - bytes;
        if (remaining > 0) { const part = buffer.subarray(0, remaining); target.push(part); bytes += part.length; }
        if (buffer.length > remaining) { truncated = true; killChild(child); }
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      const finish = (error, exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        children.delete(child);
        if (error) reject(new BridgeError('COMMAND_FAILED', 'The terminal process could not be started.'));
        else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, signal, timedOut, truncated });
      };
      child.on('error', error => finish(error));
      child.on('close', (exitCode, signal) => finish(null, exitCode, signal));
    });
    recheck(workspace, 'terminal');
    try { assertSafeContent(result.stdout); assertSafeContent(result.stderr); } catch {
      fail('SENSITIVE_OUTPUT', 'Command output was withheld because it may contain credentials.');
    }
    return result;
  }

  const host = {
    getWorkspace, getAccess: () => { const current = getAccess(); return Object.fromEntries(CAPABILITIES.map(key => [key, current[key] === true])); },
    readDocument, applyEdit, getDiagnostics, getSymbols, getEditorContext, getHover, searchWorkspaceSymbols,
    getDefinition: input => locations('vscode.executeDefinitionProvider', input),
    getReferences: input => locations('vscode.executeReferenceProvider', input),
    getTypeDefinition: input => locations('vscode.executeTypeDefinitionProvider', input),
    getImplementations: input => locations('vscode.executeImplementationProvider', input),
    previewDiff, showDocument, confirmTerminal, confirmAction, executeTerminal,
    async getGitExecutable() {
      const extension = vscode.extensions?.getExtension('vscode.git');
      if (!extension) return undefined;
      const api = await extension.activate();
      const executable = api?.getAPI?.(1)?.git?.path;
      return typeof executable === 'string' && path.isAbsolute(executable) ? executable : undefined;
    },
    emitAudit: event => audit(event), resetSession, cancelTerminal,
    dispose() { resetSession(); taskManager?.dispose(); projectManager?.dispose(); provider.dispose(); },
  };
  Object.assign(host, createWorkspaceOps({ vscode, snapshot, checkedPath, readForWorkspace, recheck, withFileLock,
    relativeInput, toRelative, hashText, assertSafeContent, pendingApprovals, fail }));
  Object.assign(host, createRefactorOps({ vscode, snapshot, checkedPath, readForWorkspace, recheck, withFileLock,
    relativeInput, toRelative, hashText, assertSafeContent, pendingApprovals, fail, previewDiff,
    languageTimeoutMs: providerTimeoutMs, approvalTimeoutMs }));
  const managerOptions = { getWorkspace, getAccess: host.getAccess, environment: safeEnvironment, audit,
    getActiveTaskCount: () => (taskManager?.activeCount() || 0) + (projectManager?.activeCount() || 0),
    checkCwd: (workspace, cwd, capability) => checkedPath(workspace, cwd, { directory: true, capability }),
    onChange: () => { try { onTaskChange(); } catch {} } };
  taskManager = createTaskManager({ ...managerOptions,
    confirm: confirmTerminal, validateCommand, environment: safeEnvironment,
  });
  projectManager = createTaskManager({ ...managerOptions, capability: 'tasks', confirm: confirmProjectTask, validateCommand });
  const projectTasks = createProjectTasks({ getWorkspace, getAccess: host.getAccess,
    startTask: input => projectManager.start({ ...input, beforeLaunch: async () => {
      const workspace = snapshot(input.workspaceId, 'tasks');
      const live = await readForWorkspace(workspace, path.join(input.cwd, 'package.json'), 'tasks');
      if (live.isDirty) fail('UNSAVED_CHANGES', 'Save package.json locally before running project tasks.');
      await input.beforeLaunch();
    } }), getTask: input => projectManager.get(input) });
  host.listProjectTasks = input => projectTasks.list(input);
  host.runProjectTask = async input => {
    const workspace = snapshot(input.workspaceId, 'tasks');
    const manifest = await resolvePath(workspace, 'package.json', { root: input.root ?? 0 });
    const live = await readForWorkspace(workspace, manifest, 'tasks');
    if (live.isDirty) fail('UNSAVED_CHANGES', 'Save package.json locally before running project tasks.');
    return projectTasks.run(input);
  };
  host.getProjectTask = input => projectTasks.get(input);
  host.startTerminalTask = input => taskManager.start(input);
  const projectOwns = input => projectManager.list({ workspaceId: input.workspaceId }).some(task => task.id === input.id);
  host.getTerminalTask = input => projectOwns(input) ? projectManager.get(input) : taskManager.get(input);
  host.listTerminalTasks = input => [...taskManager.list(input), ...projectManager.list(input)].sort((a, b) => b.createdAt - a.createdAt);
  host.cancelTerminalTask = input => projectOwns(input) ? projectManager.cancel(input) : taskManager.cancel(input);
  return host;
}

module.exports = { createVscodeHost, safeEnvironment, MAX_OUTPUT_BYTES };
