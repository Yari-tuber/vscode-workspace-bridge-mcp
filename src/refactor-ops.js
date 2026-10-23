'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { applyTextEdits, assertTextSize } = require('./text-edits');

const MAX_FILES = 20;
const MAX_EDITS = 50;
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_PLANS = 10;
const MAX_ACTIONS = 20;

function createRefactorOps({ vscode, snapshot, checkedPath, readForWorkspace, recheck, withFileLock,
  relativeInput, toRelative, hashText, assertSafeContent, previewDiff, pendingApprovals = new Set(), fail,
  languageTimeoutMs = 10_000, approvalTimeoutMs = 30_000, now = Date.now }) {
  const plans = new Map();
  const actions = new Map();
  const timeout = Number.isInteger(languageTimeoutMs) && languageTimeoutMs > 0 ? Math.min(languageTimeoutMs, 30_000) : 10_000;
  const localized = (en, cn) => /^zh(?:-|$)/i.test(vscode.env.language || '') ? cn : en;
  const key = value => path.normalize(value).toLowerCase();
  // Case folding is deliberately conservative for lock ordering, but must not
  // merge two distinct case-sensitive Linux files into one edit document.
  const documentKey = value => process.platform === 'win32' ? key(value) : path.normalize(value);
  const point = value => ({ line: value?.line, character: value?.character });
  const range = value => ({ start: point(value?.start), end: point(value?.end) });

  function authorize(workspace) { recheck(workspace, 'read'); recheck(workspace, 'refactor'); }
  function current(id) { const workspace = snapshot(id, 'refactor'); authorize(workspace); return workspace; }
  function prune() {
    for (const map of [plans, actions]) for (const [id, plan] of map) if (now() - plan.createdAt > PLAN_TTL_MS) map.delete(id);
  }
  function store(map, value, maximum) {
    prune();
    while (map.size >= maximum) map.delete(map.keys().next().value);
    const id = crypto.randomBytes(16).toString('hex');
    map.set(id, value);
    return id;
  }
  function lookup(map, id, workspace) {
    prune();
    const value = map.get(id);
    if (!value || value.workspaceId !== workspace.id) fail('REFACTOR_EXPIRED', 'The preview expired or belongs to another workspace. Prepare it again.');
    return value;
  }
  async function diskHash(absolutePath) {
    // Bounded reads prevent a concurrently enlarged file from allocating an
    // unbounded buffer. Reading disk separately detects external changes even
    // while an open dirty document still contains an older editor snapshot.
    const handle = await fs.open(absolutePath, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1 || stat.size > 512 * 1024) fail('UNSAFE_REFACTOR_FILE', 'Refactoring requires existing regular text files of at most 512 KiB.');
      const buffer = Buffer.alloc(512 * 1024 + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      if (bytesRead > 512 * 1024) fail('FILE_TOO_LARGE', 'The disk file grew while preparing the refactoring.');
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || bytesRead !== stat.size) fail('EDIT_CONFLICT', 'The disk file changed while being inspected.');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); }
      catch { fail('INVALID_TEXT', 'Refactoring supports valid UTF-8 text files only.'); }
      assertTextSize(text);
      return { hash: crypto.createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex'), mtimeMs: stat.mtimeMs };
    } finally { await handle.close(); }
  }
  async function capture(workspace, inputPath) {
    const absolute = await checkedPath(workspace, inputPath, { capability: 'refactor' });
    const relative = toRelative(workspace, absolute);
    if (!relative) fail('OUTSIDE_WORKSPACE', 'All refactoring files must be inside an authorized workspace root.');
    const document = await readForWorkspace(workspace, absolute, 'refactor');
    assertTextSize(document.text);
    const disk = await diskHash(absolute);
    await checkedPath(workspace, absolute, { capability: 'refactor' });
    authorize(workspace);
    return { absolute, ...relative, text: document.text, version: document.version, hash: hashText(document.text),
      wasDirty: document.isDirty === true, diskHash: disk.hash, mtimeMs: disk.mtimeMs };
  }
  async function source(input, positional = true) {
    const workspace = current(input?.workspaceId);
    if (typeof input.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedHash)) fail('EXPECTED_HASH_REQUIRED', 'Read the current document and pass its hash.');
    const before = await capture(workspace, input.path);
    if (before.hash !== input.expectedHash) fail('EDIT_CONFLICT', 'The source document changed. Read it and prepare the refactoring again.');
    if (positional) {
      const lines = before.text.split(/\r\n|\r|\n/);
      if (!Number.isInteger(input.line) || !Number.isInteger(input.character) || input.line < 0 || input.character < 0 || input.line >= lines.length || input.character > lines[input.line].length) fail('INVALID_POSITION', 'The position is outside the current document.');
      // Reuse the strict UTF-16 range validator, including surrogate boundaries.
      applyTextEdits(before.text, [{ range: { start: point(input), end: point(input) }, text: '' }]);
    }
    return { workspace, before };
  }
  async function languageRequest(workspace, operation) {
    let timer;
    let changed = false;
    const listener = vscode.workspace.onDidChangeTextDocument?.(() => { changed = true; });
    try {
      let result;
      try {
        result = await Promise.race([operation(), new Promise((_, reject) => {
          timer = setTimeout(() => { try { fail('LANGUAGE_TIMEOUT', 'The language service did not respond in time. Retry when it is ready.'); } catch (error) { reject(error); } }, timeout);
        })]);
      } catch (error) {
        if (error?.code === 'LANGUAGE_TIMEOUT') throw error;
        fail('LANGUAGE_PROVIDER_FAILED', 'The language service could not prepare this operation. Check its local language support.');
      }
      authorize(workspace);
      if (changed) fail('EDIT_CONFLICT', 'An editor document changed while the language service was running. Prepare the refactoring again.');
      return result;
    } finally { clearTimeout(timer); listener?.dispose(); }
  }

  function textEntries(edit) {
    // VS Code's public entries()/size omit file and notebook operations. Inspect
    // its complete entry list, fail closed on an unknown representation, and
    // rebuild a fresh text-only edit later; never apply the provider object.
    if (!(edit instanceof vscode.WorkspaceEdit) || typeof edit._allEntries !== 'function') fail('UNSUPPORTED_WORKSPACE_EDIT', 'This language service edit cannot be safely inspected on this VS Code version.');
    const entries = edit._allEntries();
    if (!Array.isArray(entries) || entries.length > MAX_FILES * MAX_EDITS) fail('REFACTOR_TOO_LARGE', 'The refactoring has too many edits. Narrow its scope.');
    for (const entry of entries) {
      if (entry?._type !== 2 || entry.uri?.scheme !== 'file' || !entry.edit || typeof entry.edit.newText !== 'string' || entry.edit.newEol !== undefined) fail('UNSAFE_WORKSPACE_EDIT', 'Only ordinary text edits in existing workspace files are supported. File, notebook, snippet and line-ending operations are excluded.');
    }
    return entries;
  }
  async function normalize(workspace, edit, before, startedAt, title) {
    const grouped = new Map();
    for (const entry of textEntries(edit)) {
      const inputPath = entry.uri.fsPath;
      if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath) || !relativeInput(workspace, inputPath)) fail('OUTSIDE_WORKSPACE', 'The language service proposed an outside or excluded file.');
      const absolute = await checkedPath(workspace, inputPath, { capability: 'refactor' });
      const normalizedKey = documentKey(absolute);
      if (!grouped.has(normalizedKey)) grouped.set(normalizedKey, { absolute, edits: [] });
      grouped.get(normalizedKey).edits.push({ range: range(entry.edit.range), text: entry.edit.newText });
      if (grouped.size > MAX_FILES || grouped.get(normalizedKey).edits.length > MAX_EDITS) fail('REFACTOR_TOO_LARGE', 'A refactoring is limited to 20 files and 50 edits per file.');
    }
    const files = [];
    let bytes = 0;
    for (const group of grouped.values()) {
      const file = await capture(workspace, group.absolute);
      if (documentKey(file.absolute) === documentKey(before.absolute) && (file.hash !== before.hash || file.version !== before.version || file.diskHash !== before.diskHash)) fail('EDIT_CONFLICT', 'The source changed while preparing the refactoring.');
      // Files modified on disk during the provider request cannot be trusted as
      // the basis of ranges returned by the language service.
      if (file.mtimeMs > startedAt + 1) fail('EDIT_CONFLICT', 'An affected disk file changed during the language-service request. Prepare again.');
      const proposed = applyTextEdits(file.text, group.edits);
      bytes += Buffer.byteLength(file.text, 'utf8') + Buffer.byteLength(proposed, 'utf8');
      if (bytes > MAX_PLAN_BYTES) fail('REFACTOR_TOO_LARGE', 'The refactoring preview exceeds its 2 MiB budget. Narrow its scope.');
      if (proposed !== file.text) files.push({ ...file, proposed, proposedHash: hashText(proposed), edits: group.edits });
    }
    // The request source remains a dependency even if the provider only edits
    // other files. It must still match at approval/application time.
    const freshSource = await capture(workspace, before.absolute);
    if (freshSource.hash !== before.hash || freshSource.version !== before.version || freshSource.diskHash !== before.diskHash) fail('EDIT_CONFLICT', 'The source document changed. Prepare again.');
    authorize(workspace);
    return { workspaceId: workspace.id, createdAt: now(), title, files, source: before };
  }
  function summary(plan) {
    return { title: plan.title, fileCount: plan.files.length, editCount: plan.files.reduce((count, file) => count + file.edits.length, 0),
      expiresAt: new Date(plan.createdAt + PLAN_TTL_MS).toISOString(),
      files: plan.files.map(file => ({ root: file.root, path: file.path, hash: file.hash, proposedHash: file.proposedHash,
        version: file.version, editCount: file.edits.length, isDirty: file.wasDirty })),
      applied: false, saved: false, persistence: 'editor_buffers_only',
      limitation: 'Application uses one text-only WorkspaceEdit. Files remain unsaved; saving multiple files to disk is not atomic.' };
  }
  function actionTitle(workspace, title) {
    assertSafeContent(title);
    let safe = title.replace(/[\x00-\x1f\x7f]/g, ' ');
    for (const root of [...workspace.roots].sort((a, b) => b.path.length - a.path.length)) {
      for (const variant of new Set([root.path, root.path.replaceAll('\\', '/')])) {
        safe = safe.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), process.platform === 'win32' ? 'gi' : 'g'), '[workspace]');
      }
    }
    return safe;
  }
  async function validateFile(workspace, file) {
    const actual = await capture(workspace, file.absolute);
    if (documentKey(actual.absolute) !== documentKey(file.absolute) || actual.version !== file.version || actual.hash !== file.hash || actual.diskHash !== file.diskHash) fail('EDIT_CONFLICT', 'An affected file changed since preview. Prepare and review the complete refactoring again.');
  }
  async function validatePlan(workspace, plan) {
    lookupExpiry(plan);
    authorize(workspace);
    for (const file of plan.files) await validateFile(workspace, file);
    if (!plan.files.some(file => documentKey(file.absolute) === documentKey(plan.source.absolute))) await validateFile(workspace, plan.source);
    authorize(workspace);
  }
  function lookupExpiry(plan) { if (now() - plan.createdAt > PLAN_TTL_MS) fail('REFACTOR_EXPIRED', 'The preview expired. Prepare it again.'); }
  async function present(workspace, plan) {
    if (!plan.files.length) return { ...summary(plan), previewed: false, noChanges: true };
    await validatePlan(workspace, plan);
    for (const file of plan.files) {
      await previewDiff({ path: file.absolute, text: file.proposed, workspaceId: workspace.id,
        expectedHash: file.hash, expectedVersion: file.version, capability: 'refactor' });
      authorize(workspace);
    }
    await validatePlan(workspace, plan);
    const refactorId = store(plans, plan, MAX_PLANS);
    return { ...summary(plan), refactorId, previewed: true };
  }

  async function prepareRename(input) {
    const { workspace, before } = await source(input);
    if (typeof input.newName !== 'string' || !input.newName.trim() || input.newName.length > 200 || /[\x00-\x20\x7f]/.test(input.newName)) fail('INVALID_NAME', 'Choose a non-empty symbol name without whitespace or control characters.');
    assertSafeContent(input.newName);
    const startedAt = now();
    const edit = await languageRequest(workspace, () => vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', vscode.Uri.file(before.absolute), new vscode.Position(input.line, input.character), input.newName));
    if (!edit) fail('NO_REFACTOR_AVAILABLE', 'The installed language service did not provide a rename at this position.');
    return present(workspace, await normalize(workspace, edit, before, startedAt, 'Semantic rename'));
  }
  async function formatDocument(input) {
    const { workspace, before } = await source(input, false);
    if (!Number.isInteger(input.tabSize) || input.tabSize < 1 || input.tabSize > 16 || typeof input.insertSpaces !== 'boolean') fail('INVALID_FORMAT_OPTIONS', 'Choose tabSize between 1 and 16 and a boolean insertSpaces.');
    const startedAt = now();
    const edits = await languageRequest(workspace, () => vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', vscode.Uri.file(before.absolute), { tabSize: input.tabSize, insertSpaces: input.insertSpaces }));
    if (!Array.isArray(edits)) fail('NO_REFACTOR_AVAILABLE', 'The installed formatter did not return text edits.');
    if (edits.length > MAX_EDITS) fail('REFACTOR_TOO_LARGE', 'The formatter returned more than 50 edits.');
    const edit = new vscode.WorkspaceEdit();
    for (const item of edits) {
      if (!item || typeof item.newText !== 'string' || item.newEol !== undefined) fail('UNSAFE_WORKSPACE_EDIT', 'The formatter returned an unsupported edit.');
      edit.replace(vscode.Uri.file(before.absolute), item.range, item.newText);
    }
    return present(workspace, await normalize(workspace, edit, before, startedAt, 'Document formatting'));
  }
  async function getCodeActions(input) {
    const { workspace, before } = await source(input);
    const startedAt = now();
    const position = new vscode.Position(input.line, input.character);
    const supplied = await languageRequest(workspace, () => vscode.commands.executeCommand('vscode.executeCodeActionProvider', vscode.Uri.file(before.absolute), new vscode.Range(position, position), undefined, 20));
    if (supplied !== undefined && !Array.isArray(supplied)) fail('INVALID_LANGUAGE_RESULT', 'The language service returned unsupported code actions.');
    const result = [];
    let excludedActions = 0;
    for (const action of (supplied || []).slice(0, MAX_ACTIONS)) {
      if (!action || typeof action.title !== 'string' || !action.title || action.title.length > 500 || action.command !== undefined || action.disabled || !action.edit) { excludedActions++; continue; }
      try {
        const title = actionTitle(workspace, action.title);
        const plan = await normalize(workspace, action.edit, before, startedAt, title);
        if (!plan.files.length) { excludedActions++; continue; }
        const actionId = store(actions, plan, MAX_ACTIONS);
        result.push({ actionId, title, kind: typeof action.kind?.value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(action.kind.value) ? action.kind.value : undefined,
          fileCount: plan.files.length, editCount: plan.files.reduce((count, file) => count + file.edits.length, 0) });
      } catch (error) {
        authorize(workspace);
        if (['EDIT_CONFLICT', 'REFACTOR_EXPIRED'].includes(error?.code)) throw error;
        excludedActions++;
      }
    }
    authorize(workspace);
    return { actions: result, excludedActions, truncated: (supplied || []).length > MAX_ACTIONS, applied: false, untrusted: true };
  }
  async function prepareCodeAction({ workspaceId, actionId }) {
    const workspace = current(workspaceId);
    const plan = lookup(actions, actionId, workspace);
    actions.delete(actionId);
    return present(workspace, plan);
  }
  async function approve(workspace, plan) {
    const button = localized('Apply reviewed refactoring', '应用已审阅的重构');
    let timer; let cancel;
    try {
      const answer = await Promise.race([
        vscode.window.showWarningMessage(localized('Apply this refactoring to the editor?', '将此重构应用到编辑器？'), { modal: true,
          detail: `${plan.title}\n\n${plan.files.map(file => file.path).join('\n')}\n\n` + localized('Review all opened diffs first. Changes stay unsaved, including previously dirty files. Approval expires in 30 seconds.', '请先审阅所有已打开的差异。修改保留为未保存状态，已有未保存内容不会被自动保存。确认 30 秒后失效。') }, button),
        new Promise(resolve => { timer = setTimeout(() => resolve(undefined), Math.min(approvalTimeoutMs, 30_000)); }),
        new Promise(resolve => { cancel = () => resolve(undefined); pendingApprovals.add(cancel); }),
      ]);
      authorize(workspace);
      return answer === button;
    } finally { clearTimeout(timer); pendingApprovals.delete(cancel); }
  }
  async function locked(paths, operation, index = 0) {
    if (index === paths.length) return operation();
    return withFileLock(paths[index], () => locked(paths, operation, index + 1));
  }
  async function applyRefactor({ workspaceId, refactorId }) {
    const workspace = current(workspaceId);
    const plan = lookup(plans, refactorId, workspace);
    // A token has one apply attempt, including denial/conflict, preventing two
    // concurrent requests from sharing a local approval or applying twice.
    plans.delete(refactorId);
    await validatePlan(workspace, plan);
    if (!await approve(workspace, plan)) fail('APPROVAL_DENIED', 'The local user did not approve this refactoring. Prepare it again to retry.');
    const paths = [...new Map([...plan.files, plan.source].map(file => [key(file.absolute), file.absolute])).values()].sort((a, b) => key(a).localeCompare(key(b)));
    return locked(paths, async () => {
      await validatePlan(workspace, plan);
      const edit = new vscode.WorkspaceEdit();
      const documents = [];
      for (const file of plan.files) {
        const uri = vscode.Uri.file(file.absolute);
        const document = await vscode.workspace.openTextDocument(uri);
        documents.push({ file, document });
        for (const item of file.edits) edit.replace(uri, new vscode.Range(item.range.start.line, item.range.start.character, item.range.end.line, item.range.end.character), item.text);
      }
      const sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(plan.source.absolute));
      authorize(workspace); lookupExpiry(plan);
      // No await between these final buffer checks and applyEdit. VS Code also
      // supplies text-document versions when serializing this fresh edit.
      for (const { file, document } of [...documents, { file: plan.source, document: sourceDocument }]) {
        if (document.version !== file.version || hashText(document.getText()) !== file.hash) fail('EDIT_CONFLICT', 'An editor document changed immediately before application. Prepare again.');
      }
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) fail('EDIT_FAILED', 'VS Code rejected the text edit. Review the current documents before preparing again.');
      authorize(workspace);
      const files = documents.map(({ file, document }) => ({ root: file.root, path: file.path, version: document.version,
        hash: hashText(document.getText()), isDirty: document.isDirty === true, wasDirty: file.wasDirty,
        matchesPreview: hashText(document.getText()) === file.proposedHash, requiresSave: document.isDirty === true }));
      return { applied: true, saved: false, requiresSave: files.some(file => file.requiresSave),
        verified: files.every(file => file.matchesPreview), fileCount: files.length, files, persistence: 'editor_buffers_only',
        limitation: 'One text-only WorkspaceEdit was submitted. Changes were not saved; later disk saves are not atomic.' };
    });
  }
  function clearRefactorPlans() { plans.clear(); actions.clear(); }
  return { prepareRename, formatDocument, getCodeActions, prepareCodeAction, applyRefactor, clearRefactorPlans };
}

module.exports = { createRefactorOps, MAX_FILES, MAX_EDITS, PLAN_TTL_MS };
