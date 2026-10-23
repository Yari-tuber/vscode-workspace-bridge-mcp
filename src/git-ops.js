'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { BridgeError, assertWorkspace, resolvePath, validateRelative, assertSafeContent } = require('./security');

const MAX_OUTPUT = 1024 * 1024;
const MAX_PATCH = 60000;
const MAX_FILE = 512 * 1024;
const queues = new Map();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new BridgeError(code, message); };
const inside = (base, target) => { const rel = path.relative(base, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
const safeName = value => { try { const result = validateRelative(value); if (!result || result !== value || value.startsWith('./')) return null; assertSafeContent(value); return result; } catch { return null; } };
function assertTextBlob(buffer) {
  if (buffer.length > MAX_FILE) fail('FILE_TOO_LARGE', 'Git review supports files up to 512 KiB.');
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) fail('BINARY_CONTENT', 'Git review supports regular UTF-8 text files only.');
  assertSafeContent(text);
  return text;
}
async function trustedGitExecutable(host, workspace = { roots: [] }) {
  const configured = typeof host.getGitExecutable === 'function' ? await host.getGitExecutable() : null;
  const candidates = configured ? [configured] : process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env.ProgramW6432, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean).map(base => path.join(base, 'Git', 'cmd', 'git.exe'))
    : ['/usr/bin/git', '/bin/git', '/usr/local/bin/git'];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || (process.platform === 'win32' && candidate.startsWith('\\\\'))) continue;
    try {
      const executable = await fs.realpath(candidate);
      if (!/^git(?:\.exe)?$/i.test(path.basename(executable)) || workspace.roots.some(root => inside(path.resolve(root.path), executable))) continue;
      if ((await fs.stat(executable)).isFile()) return executable;
    } catch {}
  }
  fail('GIT_UNAVAILABLE', 'A trusted Git installation was not found. Enable the built-in VS Code Git extension and restart the bridge.');
}

async function exclusive(key, action) {
  const previous = queues.get(key) || Promise.resolve();
  let release; const pending = new Promise(resolve => { release = resolve; });
  queues.set(key, pending);
  await previous;
  try { return await action(); } finally { release(); if (queues.get(key) === pending) queues.delete(key); }
}
async function regularMetadata(file, directory = false) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink > 1)) fail('GIT_METADATA_UNSAFE', 'Git metadata must use regular, unshared files and directories.');
  return stat;
}
async function validateMetadata(gitdir, root) {
  await regularMetadata(gitdir, true);
  if (!inside(root, await fs.realpath(gitdir))) fail('GIT_EXTERNAL_METADATA', 'Git metadata must stay inside the selected workspace root.');
  let count = 0; const deadline = Date.now() + 5000;
  async function walk(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (++count > 30000 || Date.now() > deadline) fail('GIT_REPOSITORY_TOO_LARGE', 'Git metadata validation exceeded its bounded budget.');
      const target = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) fail('GIT_METADATA_UNSAFE', 'Linked Git metadata is excluded.');
      const stat = await regularMetadata(target, entry.isDirectory());
      if (entry.isDirectory()) await walk(target);
      else if (stat.size > 16 * 1024 * 1024 && !target.includes(path.sep + 'objects' + path.sep)) fail('GIT_METADATA_UNSAFE', 'Git control metadata is too large.');
    }
  }
  await walk(gitdir);
  for (const name of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates', 'info/grafts']) {
    try { if ((await fs.readFile(path.join(gitdir, name), 'utf8')).trim()) fail('GIT_EXTERNAL_METADATA', 'Shared, alternate and grafted Git metadata is excluded.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

class Repository {
  constructor(root, gitdir, temporary, executable) { this.root = root; this.gitdir = gitdir; this.temporary = temporary; this.executable = executable; this.configHash = ''; this.deadline = Date.now() + 90000; }
  environment(extra = {}) {
    const env = {};
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT']) if (process.env[name] !== undefined) env[name] = process.env[name];
    if (process.platform === 'win32' && !process.env.SystemRoot) fail('GIT_UNAVAILABLE', 'The Windows system directory is unavailable. Restart VS Code.');
    const executablePath = process.platform === 'win32' ? [path.dirname(this.executable), path.join(process.env.SystemRoot, 'System32')].join(path.delimiter) : '/usr/bin:/bin';
    return { ...env, PATH: executablePath, TEMP: this.temporary, TMP: this.temporary, HOME: this.temporary, USERPROFILE: this.temporary, XDG_CONFIG_HOME: this.temporary, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: path.join(this.temporary, 'config'), GIT_CONFIG_GLOBAL: path.join(this.temporary, 'config'), GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: '', LC_ALL: 'C', LANG: 'C', ...extra };
  }
  async execute(args, { input, allowed = [0], isolated = false, extraEnv = {} } = {}) {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) fail('GIT_TIMEOUT', 'The Git operation exceeded its 90 second total limit. Review and retry.');
    if (!isolated) {
      const current = await fs.readFile(path.join(this.gitdir, 'config'));
      if (sha(current) !== this.configHash) fail('GIT_STATE_CHANGED', 'Repository configuration changed. Review the repository again.');
    }
    const fixed = isolated ? [] : ['--no-pager', `--git-dir=${this.gitdir}`, `--work-tree=${this.root}`, '-c', 'core.bare=false', '-c', `core.hooksPath=${path.join(this.temporary, 'hooks')}`, '-c', `core.attributesFile=${path.join(this.temporary, 'config')}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.splitIndex=false', '-c', 'core.preloadIndex=false', '-c', 'commit.gpgsign=false', '-c', 'log.showSignature=false', '-c', 'i18n.logOutputEncoding=utf-8', '-c', 'i18n.commitEncoding=utf-8', '-c', 'core.quotePath=false', ...(this.disabledFilters || [])];
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...fixed, ...args], { cwd: isolated ? this.temporary : this.root, env: this.environment(extraEnv), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = []; let size = 0; let stopped = false;
      const finishError = (code, message) => { if (!stopped) { stopped = true; child.kill(); reject(new BridgeError(code, message)); } };
      const timer = setTimeout(() => finishError('GIT_TIMEOUT', 'The Git operation exceeded its time limit.'), Math.min(15000, remaining));
      child.stdout.on('data', data => { size += data.length; if (size > MAX_OUTPUT) finishError('GIT_OUTPUT_LIMIT', 'The Git operation exceeded its 1 MiB output limit. Narrow the request.'); else output.push(data); });
      child.stderr.on('data', data => { size += data.length; if (size > MAX_OUTPUT) finishError('GIT_OUTPUT_LIMIT', 'The Git operation exceeded its output limit.'); });
      child.on('error', () => { clearTimeout(timer); finishError('GIT_UNAVAILABLE', 'Git could not be started. Install Git and restart VS Code.'); });
      child.on('close', code => { clearTimeout(timer); if (stopped) return; stopped = true; if (!allowed.includes(code)) reject(new BridgeError('GIT_OPERATION_FAILED', 'Git could not complete this operation. Check the repository locally.')); else resolve({ code, buffer: Buffer.concat(output), text: Buffer.concat(output).toString('utf8') }); });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  async inspectConfiguration() {
    const config = await fs.readFile(path.join(this.gitdir, 'config'));
    if (config.length > 128000) fail('GIT_METADATA_UNSAFE', 'Repository configuration is too large.');
    this.configHash = sha(config);
    const names = (await this.execute(['config', '--no-includes', '--file', path.join(this.gitdir, 'config'), '--null', '--name-only', '--list'], { isolated: true })).text.split('\0').filter(Boolean);
    if (names.some(name => /[\x00-\x1f\x7f]/.test(name))) fail('GIT_CONFIGURATION_UNSAFE', 'Control characters in repository configuration names are excluded.');
    const entries = (await this.execute(['config', '--no-includes', '--file', path.join(this.gitdir, 'config'), '--null', '--list'], { isolated: true })).text.split('\0').filter(Boolean);
    this.localConfig = new Map(); this.disabledFilters = [];
    for (const entry of entries) {
      const split = entry.indexOf('\n'); const originalKey = split < 0 ? entry : entry.slice(0, split); const key = originalKey.toLowerCase(); const value = split < 0 ? '' : entry.slice(split + 1);
      if (/[\x00-\x1f\x7f]/.test(originalKey + value)) fail('GIT_CONFIGURATION_UNSAFE', 'Control characters in repository configuration are excluded.');
      if (/^(?:include\.|includeif\.)/.test(key) || key === 'extensions.partialclone' || key === 'extensions.worktreeconfig' || /^remote\..*\.promisor$/.test(key) || key === 'core.alternaterefscommand') fail('GIT_CONFIGURATION_UNSAFE', 'Included configuration, lazy fetching and alternate object commands are excluded.');
      this.localConfig.set(key, value);
      // Even read-only status/diff may invoke a clean filter. Preserve the
      // case-sensitive subsection while overriding every executable filter key.
      if (/^filter\..*\.(?:clean|smudge|process|required)$/i.test(originalKey)) this.disabledFilters.push('-c', `${originalKey}=${key.endsWith('.required') ? 'false' : ''}`);
    }
  }
  async head() {
    const result = await this.execute(['rev-parse', '--verify', 'HEAD'], { allowed: [0, 128] });
    const head = result.code === 0 ? result.text.trim() : null;
    if (head !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) fail('GIT_METADATA_UNSAFE', 'The repository has an unsupported HEAD.');
    const ref = await this.execute(['symbolic-ref', '--quiet', 'HEAD'], { allowed: [0, 1] });
    const reference = ref.code === 0 ? ref.text.trim() : null;
    if (reference !== null && (!/^refs\/heads\/[A-Za-z0-9_.\/-]+$/.test(reference) || reference.includes('..') || reference.length > 220)) fail('GIT_METADATA_UNSAFE', 'The branch name is unsupported.');
    if (reference) assertSafeContent(reference);
    return { head, reference };
  }
  async snapshot() {
    const status = await this.execute(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignored=no', '--ignore-submodules=all']);
    const entries = status.text.split('\0').filter(Boolean);
    if (entries.length > 200) fail('GIT_CHANGE_LIMIT', 'At most 200 changed paths can be reviewed at once. Narrow the repository changes locally.');
    const files = []; let hiddenFileCount = 0, hiddenStagedCount = 0, total = 0;
    const hashes = [];
    for (const record of entries) {
      if (record.length < 4 || record[2] !== ' ' || !/^[ MADRCTU?!]{2}$/.test(record.slice(0, 2))) fail('GIT_METADATA_UNSAFE', 'Git returned an unsupported status record.');
      const filename = safeName(record.slice(3)); const index = record[0]; const workingTree = record[1];
      if (!filename) { hiddenFileCount++; if (index !== ' ' && index !== '?') hiddenStagedCount++; continue; }
      let digest = 'missing';
      try {
        const absolute = await resolvePath(this.workspace, filename, { root: this.rootIndex });
        const stat = await fs.stat(absolute);
        if (stat.size > MAX_FILE || (total += stat.size) > 8 * 1024 * 1024) fail('GIT_CHANGE_LIMIT', 'Changed files exceed the bounded 512 KiB per-file or 8 MiB review budget.');
        digest = sha(Buffer.concat([Buffer.from(String(stat.mode) + '\0'), await fs.readFile(absolute)]));
      } catch (error) {
        if (error.code === 'GIT_CHANGE_LIMIT') throw error;
        if (workingTree !== 'D' && index !== 'D') { hiddenFileCount++; if (index !== ' ' && index !== '?') hiddenStagedCount++; continue; }
      }
      hashes.push(filename + '\0' + digest);
      files.push({ path: filename, index, workingTree, conflict: index === 'U' || workingTree === 'U' || index + workingTree === 'AA' || index + workingTree === 'DD' });
    }
    // Bind semantic staging, rather than index timestamps/cache-tree bytes that
    // VS Code's independent Git status refresh can legitimately update.
    const head = await this.head(); const indexBytes = (await this.execute(['ls-files', '--stage', '-z'])).buffer;
    return { ...head, files, hiddenFileCount, hiddenStagedCount, stateHash: sha(Buffer.concat([status.buffer, indexBytes, Buffer.from(JSON.stringify(head) + hashes.join('\0'))])) };
  }
  async selectedPaths(paths, snapshot) {
    const unique = [...new Set(paths)];
    for (const filename of unique) {
      if (safeName(filename) !== filename) fail('UNSAFE_PATH', 'Git paths must be explicit, safe workspace-relative filenames.');
      if (!snapshot.files.some(file => file.path === filename)) fail('GIT_PATH_NOT_CHANGED', 'Each selected path must appear in the safe changed-file list.');
      try { await resolvePath(this.workspace, filename, { root: this.rootIndex }); }
      catch (error) {
        const entry = snapshot.files.find(file => file.path === filename);
        if (entry.index !== 'D' && entry.workingTree !== 'D') throw error;
        await resolvePath(this.workspace, filename, { root: this.rootIndex, create: true });
      }
    }
    return unique;
  }
  async stagedEntries() {
    const raw = (await this.execute(['ls-files', '--stage', '-z'])).text;
    const result = new Map();
    for (const entry of raw.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(entry);
      if (!match) fail('GIT_METADATA_UNSAFE', 'The index contains unsupported entries.');
      result.set(match[4], { mode: match[1], oid: match[2], stage: match[3] });
    }
    return result;
  }
  async diff(snapshot, { staged = false, paths } = {}) {
    const changed = snapshot.files.filter(file => staged ? file.index !== ' ' && file.index !== '?' : file.workingTree !== ' ' && file.workingTree !== '?');
    const selected = paths?.length ? await this.selectedPaths(paths, snapshot) : changed.map(file => file.path);
    const entries = await this.stagedEntries(); let blobBytes = 0;
    for (const filename of selected) {
      const item = entries.get(filename);
      if (item && (item.stage !== '0' || !['100644', '100755'].includes(item.mode))) fail('GIT_UNSUPPORTED_ENTRY', 'Resolve conflicts, symbolic links and submodules locally before reviewing changes.');
      if (staged && item) {
        const blob = (await this.execute(['cat-file', 'blob', item.oid])).buffer;
        if ((blobBytes += blob.length) > 8 * 1024 * 1024) fail('GIT_CHANGE_LIMIT', 'The staged file content exceeds the 8 MiB review budget.');
        assertTextBlob(blob);
      }
    }
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--no-prefix', '--unified=3'];
    if (staged) args.push('--cached');
    args.push('--', ...selected);
    let patch = selected.length ? (await this.execute(args)).text : '';
    assertSafeContent(patch);
    patch = patch.split(this.root).join('[workspace]').split(this.root.replaceAll('\\', '/')).join('[workspace]');
    const truncated = Buffer.byteLength(patch, 'utf8') > MAX_PATCH;
    if (truncated) patch = Buffer.from(patch, 'utf8').subarray(0, MAX_PATCH).toString('utf8').replace(/\uFFFD$/, '');
    const complete = staged && !truncated && !snapshot.hiddenStagedCount && !snapshot.files.some(file => file.conflict) && selected.length === changed.length && changed.every(file => selected.includes(file.path));
    return { staged, paths: selected, patch, truncated, hiddenFileCount: snapshot.hiddenFileCount, stateHash: snapshot.stateHash, reviewHash: complete && changed.length ? sha(snapshot.stateHash + patch) : null };
  }
}

async function openRepository(workspace, rootIndex = 0, executable) {
  const root = await resolvePath(workspace, '', { root: rootIndex, directory: true });
  const marker = path.join(root, '.git');
  let gitdir = marker;
  try {
    const stat = await fs.lstat(marker);
    if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) fail('GIT_METADATA_UNSAFE', 'Linked Git metadata is excluded.');
    if (stat.isFile()) {
      if (stat.size > 4096) fail('GIT_METADATA_UNSAFE', 'The Git directory pointer is too large.');
      const pointer = (await fs.readFile(marker, 'utf8')).match(/^gitdir: ([^\r\n\0]+)\r?\n?$/);
      if (!pointer) fail('GIT_METADATA_UNSAFE', 'The Git directory pointer is invalid.');
      gitdir = path.resolve(root, pointer[1]);
      if (!inside(root, gitdir)) fail('GIT_EXTERNAL_METADATA', 'Linked worktrees with metadata outside this selected root are excluded. Open a self-contained repository root.');
    } else if (!stat.isDirectory()) fail('GIT_METADATA_UNSAFE', 'The selected root has unsupported Git metadata.');
    // Validate every pointer component, rather than only its final real path.
    let current = root;
    for (const part of path.relative(root, gitdir).split(path.sep).filter(Boolean)) { current = path.join(current, part); await regularMetadata(current, true); }
    await validateMetadata(gitdir, root);
  } catch (error) { if (error instanceof BridgeError) throw error; fail('GIT_REPOSITORY_REQUIRED', 'Select the complete root of a self-contained Git repository.'); }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-bridge-git-'));
  const repo = new Repository(root, gitdir, temporary, executable || await trustedGitExecutable({}, workspace)); repo.workspace = workspace; repo.rootIndex = rootIndex;
  try { await fs.mkdir(path.join(temporary, 'hooks')); await fs.writeFile(path.join(temporary, 'config'), ''); await repo.inspectConfiguration(); return repo; }
  catch (error) { await fs.rm(temporary, { recursive: true, force: true }); throw error; }
}
async function withRepository(host, workspace, args, capability, action) {
  assertWorkspace(host, workspace.id, { capability });
  const rootKey = workspace.roots[args.root]?.path;
  return exclusive(rootKey, async () => {
    assertWorkspace(host, workspace.id, { capability });
    const executable = await trustedGitExecutable(host, workspace);
    const repo = await openRepository(workspace, args.root, executable);
    try { const result = await action(repo); assertWorkspace(host, workspace.id, { capability }); return result; }
    catch (error) { if (error instanceof BridgeError) throw error; fail('GIT_OPERATION_FAILED', 'The Git operation could not be completed. Check the repository locally.'); }
    finally { await fs.rm(repo.temporary, { recursive: true, force: true }); }
  });
}
async function confirm(host, workspace, args, title, detail, repo, stateHash) {
  if (detail.length > 6000) fail('GIT_REVIEW_LIMIT', 'The complete local confirmation would be too large. Select fewer files or use a shorter commit message.');
  assertWorkspace(host, workspace.id, { capability: 'git' });
  const approved = await host.confirmAction({ workspaceId: workspace.id, capability: 'git', title, detail });
  if (approved !== true) fail('ACTION_DECLINED', 'The Git action was declined locally.');
  assertWorkspace(host, workspace.id, { capability: 'git' });
  if ((await repo.snapshot()).stateHash !== stateHash) fail('GIT_STATE_CHANGED', 'Repository files or staging changed during approval. Review them again.');
}
function unchanged(snapshot, expected) { if (snapshot.stateHash !== expected) fail('GIT_STATE_CHANGED', 'Repository files or staging changed. Call git_status and review again.'); if (snapshot.files.some(file => file.conflict)) fail('GIT_CONFLICT', 'Resolve merge conflicts locally before changing staging.'); }

const operations = {
  status: (host, workspace, args) => withRepository(host, workspace, args, 'read', async repo => { const snapshot = await repo.snapshot(); return { ...snapshot, branch: snapshot.reference?.slice(11) ?? null, reference: undefined, hiddenStagedCount: undefined }; }),
  diff: (host, workspace, args) => withRepository(host, workspace, args, 'read', async repo => repo.diff(await repo.snapshot(), args)),
  log: (host, workspace, args) => withRepository(host, workspace, args, 'read', async repo => {
    if (!(await repo.head()).head) return { commits: [] };
    const output = (await repo.execute(['log', '--no-show-signature', '--no-notes', `--max-count=${args.limit}`, '--format=%H%x00%cs%x00%s%x00', '--no-decorate'])).text;
    const parts = output.split('\0'); const commits = [];
    for (let i = 0; i + 2 < parts.length; i += 3) { const hash = parts[i].trim(); const date = parts[i + 1]; let subject = parts[i + 2]; if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('GIT_METADATA_UNSAFE', 'Git returned unsupported history metadata.'); try { assertSafeContent(subject); } catch { subject = '[sensitive commit subject omitted]'; } subject = subject.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email omitted]').split(repo.root).join('[workspace]').split(repo.root.replaceAll('\\', '/')).join('[workspace]').slice(0, 300); commits.push({ hash, date, subject }); }
    return { commits };
  }),
  stage: (host, workspace, args) => withRepository(host, workspace, args, 'git', async repo => {
    const snapshot = await repo.snapshot(); unchanged(snapshot, args.expectedStateHash);
    const paths = await repo.selectedPaths(args.paths, snapshot); const prepared = [];
    const tracked = await repo.stagedEntries();
    for (const filename of paths) {
      const existing = tracked.get(filename);
      if (existing && (existing.stage !== '0' || !['100644', '100755'].includes(existing.mode))) fail('GIT_UNSUPPORTED_ENTRY', 'Symbolic links, submodules and conflicts cannot be staged.');
      const entry = snapshot.files.find(file => file.path === filename);
      if (entry.workingTree === 'D') { prepared.push({ path: filename, deleted: true }); continue; }
      const absolute = await resolvePath(workspace, filename, { root: args.root }); const stat = await fs.stat(absolute); const content = await fs.readFile(absolute);
      if (content.length > MAX_FILE) fail('FILE_TOO_LARGE', 'Git staging supports files up to 512 KiB.');
      assertTextBlob(content);
      prepared.push({ path: filename, content, mode: existing?.mode || (process.platform !== 'win32' && stat.mode & 0o111 ? '100755' : '100644') });
    }
    await confirm(host, workspace, args, 'Stage reviewed Git files', `Stage these exact files using their raw UTF-8 bytes (Git clean filters and line-ending conversion are bypassed):\n${paths.join('\n')}`, repo, snapshot.stateHash);
    const records = [];
    const format = (await repo.execute(['rev-parse', '--show-object-format'])).text.trim(); const zero = '0'.repeat(format === 'sha256' ? 64 : 40);
    for (const item of prepared) { const oid = item.deleted ? zero : (await repo.execute(['hash-object', '-w', '--no-filters', '--stdin'], { input: item.content })).text.trim(); if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) fail('GIT_METADATA_UNSAFE', 'Git returned an unsupported object identifier.'); records.push(`${item.deleted ? '0' : item.mode} ${oid}\t${item.path}\0`); }
    unchanged(await repo.snapshot(), snapshot.stateHash);
    assertWorkspace(host, workspace.id, { capability: 'git' });
    await repo.execute(['update-index', '-z', '--index-info'], { input: records.join('') });
    return { staged: paths, ...(await repo.snapshot()) };
  }),
  unstage: (host, workspace, args) => withRepository(host, workspace, args, 'git', async repo => {
    const snapshot = await repo.snapshot(); unchanged(snapshot, args.expectedStateHash); const paths = await repo.selectedPaths(args.paths, snapshot);
    const tracked = await repo.stagedEntries(); const format = (await repo.execute(['rev-parse', '--show-object-format'])).text.trim(); const zero = '0'.repeat(format === 'sha256' ? 64 : 40); const records = [];
    for (const filename of paths) {
      const current = tracked.get(filename); if (current && (current.stage !== '0' || !['100644', '100755'].includes(current.mode))) fail('GIT_UNSUPPORTED_ENTRY', 'Symbolic links, submodules and conflicts cannot be unstaged.');
      const output = snapshot.head ? (await repo.execute(['ls-tree', '-z', snapshot.head, '--', filename])).text : '';
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(output);
      if (output && (!match || match[3] !== filename)) fail('GIT_UNSUPPORTED_ENTRY', 'Only ordinary tracked files can be unstaged.');
      records.push(`${match ? match[1] : '0'} ${match ? match[2] : zero}\t${filename}\0`);
    }
    await confirm(host, workspace, args, 'Unstage reviewed Git files', `Restore only these index entries to HEAD. Working files stay as they are:\n${paths.join('\n')}`, repo, snapshot.stateHash);
    await repo.execute(['update-index', '-z', '--index-info'], { input: records.join('') });
    return { unstaged: paths, ...(await repo.snapshot()) };
  }),
  commit: (host, workspace, args) => withRepository(host, workspace, args, 'git', async repo => {
    assertSafeContent(args.message);
    if ([...(await repo.stagedEntries()).values()].some(entry => entry.stage !== '0' || !['100644', '100755'].includes(entry.mode))) fail('GIT_UNSUPPORTED_ENTRY', 'Repositories with indexed symlinks, submodules or conflicts require local Git commit review.');
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-apply', 'rebase-merge', 'sequencer']) {
      try { await fs.lstat(path.join(repo.gitdir, name)); fail('GIT_OPERATION_IN_PROGRESS', 'Finish or abort the merge, rebase, cherry-pick or bisect locally before committing through the bridge.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const snapshot = await repo.snapshot(); const review = await repo.diff(snapshot, { staged: true });
    if (!review.reviewHash || review.reviewHash !== args.expectedReviewHash) fail('GIT_REVIEW_REQUIRED', 'Call git_diff with staged=true, inspect its complete safe patch, and supply its current reviewHash. Hidden files, conflicts and truncated patches cannot be committed.');
    const authorName = repo.localConfig.get('user.name'); const authorEmail = repo.localConfig.get('user.email');
    if (!authorName || !authorEmail || /[\r\n\0<>]/.test(authorName) || authorName.length > 100 || !/^[^\s<>@]{1,100}@[^\s<>@]{1,150}$/.test(authorEmail)) fail('GIT_IDENTITY_REQUIRED', 'Set repository-local user.name and user.email in Git before committing. Global credentials and identity files are not read.');
    const identity = { GIT_AUTHOR_NAME: authorName, GIT_COMMITTER_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_EMAIL: authorEmail };
    await confirm(host, workspace, args, 'Commit reviewed Git changes', `Commit message:\n${args.message}\n\nExact staged files:\n${review.paths.join('\n')}\n\nOnly the staged patch returned by git_diff will be committed. Hooks and signing are disabled.`, repo, snapshot.stateHash);
    // write-tree may update the cache-tree extension in its index. Use a private
    // copy so internal Git bookkeeping cannot invalidate the approved fingerprint.
    const privateIndex = path.join(repo.temporary, 'reviewed-index');
    await fs.copyFile(path.join(repo.gitdir, 'index'), privateIndex);
    const tree = (await repo.execute(['write-tree'], { extraEnv: { GIT_INDEX_FILE: privateIndex } })).text.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) fail('GIT_METADATA_UNSAFE', 'Git returned an unsupported tree.');
    const argv = ['commit-tree', tree]; if (snapshot.head) argv.push('-p', snapshot.head); argv.push('-F', '-');
    const hash = (await repo.execute(argv, { input: args.message + '\n', extraEnv: identity })).text.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) fail('GIT_METADATA_UNSAFE', 'Git returned an unsupported commit.');
    unchanged(await repo.snapshot(), snapshot.stateHash); assertWorkspace(host, workspace.id, { capability: 'git' });
    const update = ['update-ref']; if (!snapshot.reference) update.push('--no-deref'); update.push(snapshot.reference || 'HEAD', hash, snapshot.head || '0'.repeat(hash.length));
    await repo.execute(update);
    return { committed: true, hash, paths: review.paths, hooksRun: false, signed: false };
  })
};

module.exports = { operations, openRepository, MAX_PATCH };
