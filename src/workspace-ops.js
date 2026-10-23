'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_DIRECTORY_DEPTH = 16;
const TRASH_APPROVAL_TIMEOUT_MS = 30_000;

function createWorkspaceOps({ vscode, snapshot, checkedPath, readForWorkspace, recheck, withFileLock,
  relativeInput, toRelative, hashText, assertSafeContent, pendingApprovals, fail }) {
  const localized = (en, cn) => /^zh(?:-|$)/i.test(vscode.env.language || '') ? cn : en;
  const key = value => path.normalize(value).toLowerCase();

  function relativePath(workspace, absolutePath) {
    if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) fail('INVALID_PATH', 'An absolute workspace path is required.');
    // relativeInput validates every name, including names whose parents do not
    // exist yet, before the first directory is created.
    const relative = relativeInput(workspace, absolutePath);
    if (!relative || !Number.isInteger(relative.root) || !workspace.roots[relative.root]) {
      fail('OUTSIDE_WORKSPACE', 'The requested path is outside this workspace or excluded by its path policy.');
    }
    return relative;
  }

  function metadata(workspace, absolutePath) {
    const relative = toRelative(workspace, absolutePath);
    if (!relative) fail('PATH_CHANGED', 'The path changed. Request the workspace overview again.');
    return relative;
  }

  function requireHash(expectedHash) {
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      fail('EXPECTED_HASH_REQUIRED', 'Pass the current file hash from read_file.');
    }
  }

  async function lstatOrAbsent(absolutePath) {
    try { return await fs.lstat(absolutePath); } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail('PATH_UNAVAILABLE', 'The path cannot be accessed.');
    }
  }

  async function ensureAbsent(absolutePath) {
    if (await lstatOrAbsent(absolutePath)) fail('FILE_EXISTS', 'The target already exists. Choose an unused file name.');
  }

  function assertRegularFile(stat) {
    if (stat.isSymbolicLink()) fail('SYMLINK_DENIED', 'Symbolic links and junctions are excluded.');
    if (!stat.isFile()) fail('INVALID_FILE_TYPE', 'Choose a single regular text file. Directories are excluded.');
    if (stat.nlink > 1) fail('HARDLINK_DENIED', 'Files with multiple hard links are excluded.');
    if (stat.size > MAX_TEXT_BYTES) fail('FILE_TOO_LARGE', 'Files must be at most 512 KiB.');
  }

  async function diskText(absolutePath, initialStat) {
    let handle;
    try {
      handle = await fs.open(absolutePath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0));
    } catch (error) {
      if (error.code === 'ELOOP') fail('SYMLINK_DENIED', 'Symbolic links and junctions are excluded.');
      fail('PATH_UNAVAILABLE', 'The file cannot be opened safely.');
    }
    try {
      let stat;
      let bytesRead = 0;
      const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
      try { stat = await handle.stat(); } catch { fail('PATH_UNAVAILABLE', 'The file cannot be read safely.'); }
      assertRegularFile(stat);
      if (stat.dev !== initialStat.dev || stat.ino !== initialStat.ino) fail('PATH_CHANGED', 'The file was replaced. Read it again.');
      // Bounded descriptor reads avoid an unbounded allocation if the file grew
      // after stat(), and O_NOFOLLOW rejects a last-component link on POSIX.
      while (bytesRead < buffer.length) {
        let count;
        try { ({ bytesRead: count } = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)); }
        catch { fail('PATH_UNAVAILABLE', 'The file cannot be read safely.'); }
        if (!count) break;
        bytesRead += count;
      }
      if (bytesRead > MAX_TEXT_BYTES) fail('FILE_TOO_LARGE', 'Files must be at most 512 KiB.');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); }
      catch { fail('BINARY_CONTENT', 'Only UTF-8 text files can be moved or sent to Trash.'); }
      assertSafeContent(text);
      return { text, identity: `${stat.dev}:${stat.ino}` };
    } finally { await handle.close().catch(() => {}); }
  }

  async function readGuarded(workspace, inputPath, expectedHash, expected) {
    const absolutePath = await checkedPath(workspace, inputPath, { capability: 'edit' });
    const stat = await lstatOrAbsent(absolutePath);
    if (!stat) fail('PATH_UNAVAILABLE', 'The source file no longer exists.');
    assertRegularFile(stat);
    const document = await readForWorkspace(workspace, absolutePath, 'edit');
    if (document.isDirty) fail('UNSAVED_CHANGES', 'Save or discard the local unsaved changes before moving or deleting this file.');
    if (Buffer.byteLength(document.text, 'utf8') > MAX_TEXT_BYTES) fail('FILE_TOO_LARGE', 'The editor buffer must be at most 512 KiB.');
    assertSafeContent(document.text);
    const disk = await diskText(absolutePath, stat);
    if (hashText(document.text) !== expectedHash || hashText(disk.text) !== expectedHash
      || (expected && document.version !== expected.version)) {
      fail('EDIT_CONFLICT', 'The file changed. Read it again before moving or deleting it.');
    }
    if (expected && disk.identity !== expected.identity) fail('PATH_CHANGED', 'The file was replaced. Read it again.');
    await checkedPath(workspace, absolutePath, { capability: 'edit' });
    const finalStat = await lstatOrAbsent(absolutePath);
    if (!finalStat) fail('PATH_UNAVAILABLE', 'The source file no longer exists.');
    assertRegularFile(finalStat);
    if (`${finalStat.dev}:${finalStat.ino}` !== disk.identity) fail('PATH_CHANGED', 'The file was replaced. Read it again.');
    recheck(workspace, 'edit');
    return { absolutePath, version: document.version, identity: disk.identity };
  }

  function assertLiveDocument(absolutePath, expectedHash, expectedVersion) {
    const uri = vscode.Uri.file(absolutePath).toString();
    const live = (vscode.workspace.textDocuments || []).find(document => document.uri.toString() === uri);
    if (!live) fail('DOCUMENT_CHANGED', 'The editor document closed. Read the file again.');
    if (live.isDirty) fail('UNSAVED_CHANGES', 'Save or discard the local unsaved changes before moving or deleting this file.');
    // Recheck the actual document synchronously after all asynchronous path and
    // disk checks, immediately before handing the mutation to VS Code.
    if (live.version !== expectedVersion || hashText(live.getText()) !== expectedHash) {
      fail('EDIT_CONFLICT', 'The editor document changed. Read it again.');
    }
  }

  async function createDirectory({ workspaceId, path: inputPath }) {
    const workspace = snapshot(workspaceId, 'edit');
    const relative = relativePath(workspace, inputPath);
    const parts = relative.path.replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
    if (parts.length > MAX_DIRECTORY_DEPTH) fail('DIRECTORY_DEPTH_LIMIT', 'Create at most 16 directory levels in one request.');
    const absolutePath = path.resolve(workspace.roots[relative.root].path, ...parts);
    return withFileLock(absolutePath, async () => {
      recheck(workspace, 'edit');
      const created = [];
      const existed = [];
      let current = await checkedPath(workspace, workspace.roots[relative.root].path, { directory: true, capability: 'edit' });
      for (const part of parts) {
        const proposed = path.join(current, part);
        const checked = await checkedPath(workspace, proposed, { create: true, directory: true, capability: 'edit' });
        if (key(checked) !== key(proposed)) fail('PATH_CHANGED', 'The directory path changed. Request the workspace overview again.');
        const present = await lstatOrAbsent(checked);
        if (present) {
          // checkedPath already validates directory type, links and containment.
          await checkedPath(workspace, checked, { directory: true, capability: 'edit' });
          existed.push(metadata(workspace, checked));
        } else {
          await checkedPath(workspace, current, { directory: true, capability: 'edit' });
          await checkedPath(workspace, checked, { create: true, directory: true, capability: 'edit' });
          recheck(workspace, 'edit');
          try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(checked)); }
          catch { fail('CREATE_DIRECTORY_FAILED', 'VS Code could not create the directory.'); }
          await checkedPath(workspace, checked, { directory: true, capability: 'edit' });
          created.push(metadata(workspace, checked));
        }
        current = checked;
      }
      await checkedPath(workspace, absolutePath, { directory: true, capability: 'edit' });
      return { ...metadata(workspace, absolutePath), created, existed };
    });
  }

  async function checkedTarget(workspace, inputPath) {
    const relative = relativePath(workspace, inputPath);
    if (!relative.path) fail('INVALID_FILE_TYPE', 'Choose a new file name inside the workspace.');
    const target = await checkedPath(workspace, inputPath, { create: true, capability: 'edit' });
    await checkedPath(workspace, path.dirname(target), { directory: true, capability: 'edit' });
    await ensureAbsent(target);
    recheck(workspace, 'edit');
    const uri = vscode.Uri.file(target).toString();
    if ((vscode.workspace.textDocuments || []).some(doc => doc.uri.toString() === uri && doc.isDirty)) {
      fail('UNSAVED_CHANGES', 'An unsaved editor already uses the target file name. Review it locally first.');
    }
    return target;
  }

  async function moveFile({ workspaceId, path: inputPath, targetPath, expectedHash }) {
    const workspace = snapshot(workspaceId, 'edit');
    requireHash(expectedHash);
    relativePath(workspace, inputPath);
    relativePath(workspace, targetPath);
    if (key(inputPath) === key(targetPath)) fail('SAME_PATH', 'Choose a different file name. Case-only renames are excluded.');
    const source = await checkedPath(workspace, inputPath, { capability: 'edit' });
    const target = await checkedTarget(workspace, targetPath);
    if (key(source) === key(target)) fail('SAME_PATH', 'Choose a different file name. Case-only renames are excluded.');
    return withFileLock(source, async () => {
      recheck(workspace, 'edit');
      const before = await readGuarded(workspace, inputPath, expectedHash);
      if (key(before.absolutePath) !== key(source)) fail('PATH_CHANGED', 'The source path changed. Read it again.');
      const destination = await checkedTarget(workspace, targetPath);
      if (key(destination) !== key(target)) fail('PATH_CHANGED', 'The target path changed. Read the workspace overview again.');
      await readGuarded(workspace, source, expectedHash, before);
      await checkedTarget(workspace, destination);
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(vscode.Uri.file(source), vscode.Uri.file(destination), { overwrite: false, ignoreIfExists: false });
      recheck(workspace, 'edit');
      assertLiveDocument(source, expectedHash, before.version);
      let applied;
      try { applied = await vscode.workspace.applyEdit(edit); }
      catch { fail('MOVE_FAILED', 'VS Code could not move the file without overwriting a target.'); }
      if (!applied) fail('MOVE_FAILED', 'VS Code could not move the file without overwriting a target.');
      await checkedPath(workspace, destination, { capability: 'edit' });
      await readGuarded(workspace, destination, expectedHash);
      if (await lstatOrAbsent(source)) fail('MOVE_UNVERIFIED', 'The source name is still present. Review the files locally.');
      recheck(workspace, 'edit');
      return { moved: true, from: metadata(workspace, source), to: metadata(workspace, destination), hash: expectedHash };
    });
  }

  async function approveTrash(workspace, relative) {
    const approve = localized('Move to Trash', '移到回收站');
    const expiresAt = performance.now() + TRASH_APPROVAL_TIMEOUT_MS;
    let timer;
    let cancel;
    try {
      const answer = await Promise.race([
        vscode.window.showWarningMessage(localized('Move this file to Trash?', '将这个文件移到回收站？'), {
          modal: true,
          detail: `${relative.path}\n\n` + localized('Only this file will be moved. Approval expires in 30 seconds. Permanent deletion is never used.',
            '只处理这个文件。本次确认 30 秒后失效，不会降级为永久删除。'),
        }, approve),
        new Promise(resolve => { timer = setTimeout(() => resolve(undefined), TRASH_APPROVAL_TIMEOUT_MS); }),
        new Promise(resolve => { cancel = () => resolve(undefined); pendingApprovals.add(cancel); }),
      ]);
      recheck(workspace, 'edit');
      if (answer !== approve || performance.now() >= expiresAt) fail('APPROVAL_DENIED', 'The local user did not approve moving the file to Trash before confirmation expired.');
    } finally { clearTimeout(timer); pendingApprovals.delete(cancel); }
  }

  async function deleteFile({ workspaceId, path: inputPath, expectedHash }) {
    const workspace = snapshot(workspaceId, 'edit');
    requireHash(expectedHash);
    relativePath(workspace, inputPath);
    const source = await checkedPath(workspace, inputPath, { capability: 'edit' });
    return withFileLock(source, async () => {
      recheck(workspace, 'edit');
      const before = await readGuarded(workspace, inputPath, expectedHash);
      if (key(before.absolutePath) !== key(source)) fail('PATH_CHANGED', 'The source path changed. Read it again.');
      const relative = metadata(workspace, source);
      await approveTrash(workspace, relative);
      await readGuarded(workspace, source, expectedHash, before);
      recheck(workspace, 'edit');
      assertLiveDocument(source, expectedHash, before.version);
      try { await vscode.workspace.fs.delete(vscode.Uri.file(source), { useTrash: true, recursive: false }); }
      catch { fail('TRASH_FAILED', 'VS Code could not move the file to Trash. No permanent-delete fallback was attempted.'); }
      recheck(workspace, 'edit');
      if (await lstatOrAbsent(source)) fail('DELETE_UNVERIFIED', 'The file name is still present. Review it locally.');
      return { deleted: true, trashed: true, ...relative };
    });
  }

  return { createDirectory, moveFile, deleteFile };
}

module.exports = { createWorkspaceOps, MAX_TEXT_BYTES, MAX_DIRECTORY_DEPTH, TRASH_APPROVAL_TIMEOUT_MS };
