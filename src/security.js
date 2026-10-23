'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class BridgeError extends Error {
  constructor(code, message) { super(message); this.name = 'BridgeError'; this.code = code; }
}
const deny = (code, message) => { throw new BridgeError(code, message); };
function assertWorkspace(host, id, { capability = 'read' } = {}) {
  if (!['read', 'edit', 'terminal'].includes(capability)) deny('ACCESS_DENIED', 'Unknown capability.');
  const workspace = host.getWorkspace();
  if (!workspace?.trusted) deny('UNTRUSTED_WORKSPACE', 'Trust the workspace locally before starting the bridge.');
  if (!workspace.roots?.length || workspace.roots.some(r => typeof r.path !== 'string')) deny('NO_WORKSPACE', 'Open a local folder first.');
  if (id !== undefined && id !== workspace.id) deny('WORKSPACE_CHANGED', 'The workspace changed. Call workspace_overview and start a new operation.');
  if (host.getAccess()?.[capability] !== true) deny('ACCESS_DENIED', `The ${capability} capability is disabled. Enable it in the local Workspace Bridge panel.`);
  return workspace;
}
const visibleDot = new Set(['.github', '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.prettierrc.json', '.eslintrc.json']);
function isSensitivePath(relative) {
  return relative.replaceAll('\\', '/').split('/').some(name => {
    if (name === '' || name === '.') return false;
    if (name.startsWith('.') && !visibleDot.has(name)) return true;
    return /^(?:credentials?|secrets?|tokens?)(?:[._-].*)?$/i.test(name)
      || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/i.test(name)
      || /\.(?:pem|key|p12|pfx|jks|keystore|log|sqlite3?|db)$/i.test(name)
      || /^(?:known_hosts|authorized_keys|kubeconfig|tunnel\.ya?ml|route-state\.json)$/i.test(name);
  });
}
function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function validateRelative(relative) {
  if (typeof relative !== 'string' || relative.length > 1000 || /[\x00-\x1f\x7f:]/.test(relative)) deny('UNSAFE_PATH', 'Use a relative workspace path without control characters or drive prefixes.');
  const value = relative.replaceAll('\\', '/');
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(relative) || value.split('/').includes('..')) deny('OUTSIDE_WORKSPACE', 'Paths must stay inside the selected workspace root.');
  if (isSensitivePath(value)) deny('SENSITIVE_PATH', 'Hidden state, credentials, keys, databases and logs are excluded.');
  if (value.split('/').some(part => (part !== '.' && /[. ]$/.test(part)) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) deny('UNSAFE_PATH', 'Device names and ambiguous trailing dots or spaces are excluded.');
  return value;
}
async function resolvePath(workspace, relative, { root = 0, create = false, directory = false } = {}) {
  const normalized = validateRelative(relative);
  if (!Number.isInteger(root) || root < 0 || root >= workspace.roots.length) deny('INVALID_ROOT', 'Choose a root index from workspace_overview.');
  try {
    const realRoot = await fs.realpath(workspace.roots[root].path);
    const target = path.resolve(realRoot, normalized || '.');
    if (!contained(realRoot, target)) deny('OUTSIDE_WORKSPACE', 'Path is outside the workspace.');
    let current = realRoot;
    const pieces = path.relative(realRoot, target).split(path.sep).filter(Boolean);
    for (let i = 0; i < pieces.length; i++) {
      current = path.join(current, pieces[i]);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (e) {
        if (create && i === pieces.length - 1 && e.code === 'ENOENT') return current;
        throw e;
      }
      if (stat.isSymbolicLink()) deny('SYMLINK_DENIED', 'Symbolic links and junctions are excluded.');
      if (!stat.isDirectory() && !stat.isFile()) deny('SPECIAL_FILE', 'Only regular files and directories are supported.');
      if (stat.isFile() && stat.nlink > 1) deny('HARDLINK_DENIED', 'Files with multiple hard links are excluded.');
      if (!contained(realRoot, await fs.realpath(current))) deny('OUTSIDE_WORKSPACE', 'Resolved path is outside the workspace.');
    }
    const stat = await fs.stat(target);
    if (directory ? !stat.isDirectory() : !stat.isFile()) deny('INVALID_FILE_TYPE', directory ? 'Choose a directory.' : 'Choose a regular file.');
    return target;
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    deny('PATH_UNAVAILABLE', 'The path does not exist or cannot be accessed.');
  }
}
function hashText(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function assertSafeContent(text) {
  if (typeof text !== 'string') deny('INVALID_TEXT', 'Text must be a string.');
  if (text.includes('\0')) deny('BINARY_CONTENT', 'Binary content is excluded.');
  const patterns = [
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
    /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/,
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b["']?\s*[:=]\s*["'][A-Za-z0-9+/_.=-]{16,}["']/i
  ];
  if (patterns.some(re => re.test(text))) deny('SENSITIVE_CONTENT', 'Possible credentials detected. The content was not returned or written.');
}
function toRelative(workspace, absolute) {
  for (let root = 0; root < workspace.roots.length; root++) {
    const base = path.resolve(workspace.roots[root].path);
    if (contained(base, absolute)) {
      const relative = path.relative(base, absolute).replaceAll('\\', '/');
      try { validateRelative(relative); return { root, path: relative }; } catch {}
    }
  }
  return null;
}
module.exports = { BridgeError, assertWorkspace, resolvePath, isSensitivePath, validateRelative, hashText, assertSafeContent, toRelative };
