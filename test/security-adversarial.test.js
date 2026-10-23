'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const {
  BridgeError, assertWorkspace, resolvePath, assertSafeContent, hashText, toRelative,
} = require('../src/security');

function safeFailure(error) {
  assert.ok(error instanceof BridgeError, 'Failures must use the public, sanitized error type');
  assert.equal(typeof error.code, 'string');
  assert.ok(error.code.length > 0);
  return true;
}

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-bridge-security-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'Project');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'public.txt'), 'public fixture content\n');
  await fs.writeFile(path.join(outside, 'outside.txt'), 'outside fixture content\n');
  const workspace = { id: 'fixture-workspace', name: 'fixture', trusted: true, roots: [{ name: 'fixture', path: root }] };
  return { base, root, outside, workspace };
}

test('workspace authorization binds trust, capabilities, and current identity', () => {
  const workspace = { id: 'workspace-one', trusted: true, roots: [{ name: 'fixture', path: process.cwd() }] };
  const host = { getWorkspace: () => workspace, getAccess: () => ({ read: true, edit: false, terminal: false }) };
  assert.deepEqual(assertWorkspace(host, workspace.id), workspace);
  assert.throws(() => assertWorkspace(host, 'stale-workspace'), safeFailure);
  for (const capability of ['edit', 'terminal']) assert.throws(() => assertWorkspace(host, workspace.id, { capability }), safeFailure);
  workspace.trusted = false;
  assert.throws(() => assertWorkspace(host, workspace.id), safeFailure);
  assert.throws(() => assertWorkspace({ ...host, getWorkspace: () => null }, workspace.id), safeFailure);
  assert.throws(() => assertWorkspace({ ...host, getWorkspace: () => ({ ...workspace, trusted: true, roots: [] }) }, workspace.id), safeFailure);
});

test('unknown capability names cannot inherit permission from Object.prototype', () => {
  const workspace = { id: 'fixture', trusted: true, roots: [{ path: process.cwd() }] };
  const host = { getWorkspace: () => workspace, getAccess: () => ({ read: true }) };
  for (const capability of ['toString', 'constructor', '__proto__', 'unknown']) {
    assert.throws(() => assertWorkspace(host, workspace.id, { capability }), safeFailure);
  }
});

test('relative regular files and directories resolve inside the selected root', async t => {
  const { root, workspace } = await fixture(t);
  assert.equal(await resolvePath(workspace, 'src/public.txt'), path.join(root, 'src', 'public.txt'));
  assert.equal(await resolvePath(workspace, 'src', { directory: true }), path.join(root, 'src'));
  assert.equal(await resolvePath(workspace, 'src/new.txt', { create: true }), path.join(root, 'src', 'new.txt'));
  await assert.rejects(resolvePath(workspace, 'src/public.txt', { directory: true }), safeFailure);
  await assert.rejects(resolvePath(workspace, 'src'), safeFailure);
});

test('traversal, absolute paths, drive prefixes, streams, and control bytes are rejected', async t => {
  const { outside, workspace } = await fixture(t);
  const drive = 'C' + ':';
  const paths = [
    '../outside/outside.txt', 'src/../../outside/outside.txt', '..\\outside\\outside.txt',
    outside, drive + '\\Users\\example\\outside.txt', drive + 'relative.txt',
    '\\\\server\\share\\file.txt', '\\\\?\\' + drive + '\\file.txt',
    'src/public.txt:stream', 'file' + ':' + '///outside.txt',
    'src/pub\0lic.txt', 'src/pub\nlic.txt',
  ];
  for (const value of paths) await assert.rejects(resolvePath(workspace, value, { create: true }), safeFailure);
});

test('invalid root indices cannot select another workspace', async t => {
  const { workspace } = await fixture(t);
  for (const root of [-1, 1, 0.5, '0', null, NaN, Infinity]) {
    await assert.rejects(resolvePath(workspace, 'src/public.txt', { root }), safeFailure);
  }
});

test('hidden state, credentials, keys, databases, and logs are denied even for creation', async t => {
  const { workspace } = await fixture(t);
  for (const value of [
    '.env', '.env.local', '.git/config', '.ssh/id_ed25519', '.npmrc', '.netrc',
    '.aws/credentials', 'credentials.json', 'secrets.txt', 'tokens.json',
    'private.pem', 'private.key', 'archive.p12', 'archive.pfx', 'data.sqlite', 'app.log',
  ]) await assert.rejects(resolvePath(workspace, value, { create: true }), safeFailure);
});

test('Windows device names and trailing-dot aliases cannot become new files', async t => {
  const { workspace } = await fixture(t);
  for (const value of ['NUL', 'CON.txt', 'aux', 'COM1.log.txt', 'LPT1.txt', 'src/public.txt.', 'src/public.txt ']) {
    await assert.rejects(resolvePath(workspace, value, { create: true }), safeFailure);
  }
});

test('symlink or junction ancestors cannot escape the authorized root', async t => {
  const { root, outside, workspace } = await fixture(t);
  try { await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('The test environment cannot create a link');
    throw error;
  }
  await assert.rejects(resolvePath(workspace, 'linked/outside.txt'), safeFailure);
  await assert.rejects(resolvePath(workspace, 'linked/new.txt', { create: true }), safeFailure);
  await assert.rejects(resolvePath(workspace, 'linked', { directory: true }), safeFailure);
});

test('hard links cannot expose a second name for files outside the root', async t => {
  const { root, outside, workspace } = await fixture(t);
  try { await fs.link(path.join(outside, 'outside.txt'), path.join(root, 'hardlink.txt')); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'EXDEV'].includes(error.code)) return t.skip('The test environment cannot create a hard link');
    throw error;
  }
  await assert.rejects(resolvePath(workspace, 'hardlink.txt'), safeFailure);
});

test('relative metadata excludes outside roots, secret paths, and alternate streams', async t => {
  const { root, outside, workspace } = await fixture(t);
  assert.deepEqual(toRelative(workspace, path.join(root, 'src', 'public.txt')), { root: 0, path: 'src/public.txt' });
  assert.equal(toRelative(workspace, path.join(outside, 'outside.txt')), null);
  assert.equal(toRelative(workspace, path.join(root, '.env')), null);
  assert.equal(toRelative(workspace, path.join(root, 'src', 'public.txt:stream')), null);
});

test('Unix root containment remains case-sensitive', { skip: process.platform === 'win32' }, async t => {
  const { base, workspace } = await fixture(t);
  const lowercase = path.join(base, 'project');
  try { await fs.mkdir(lowercase); }
  catch (error) {
    if (error.code === 'EEXIST') return t.skip('The temporary filesystem is case-insensitive');
    throw error;
  }
  await fs.writeFile(path.join(lowercase, 'different.txt'), 'different root');
  assert.equal(toRelative(workspace, path.join(lowercase, 'different.txt')), null);
});

test('known credential formats never pass the content boundary', () => {
  const fabricated = [
    '-----BEGIN ' + 'PRIVATE KEY-----\nfixture\n-----END ' + 'PRIVATE KEY-----',
    'ghp_' + 'a1'.repeat(24),
    'github_pat_' + 'a1'.repeat(30),
    'AKIA' + 'A1'.repeat(8),
    'sk-' + 'proj-' + 'a1'.repeat(24),
    'api_key = "' + 'a1'.repeat(20) + '"',
    'password: "' + 'a1'.repeat(20) + '"',
  ];
  for (const content of fabricated) assert.throws(() => assertSafeContent(content), safeFailure);
  assert.throws(() => assertSafeContent('public\0binary'), safeFailure);
  assert.throws(() => assertSafeContent(Buffer.from('text')), safeFailure);
});

test('ordinary source and explicit documentation placeholders remain usable', () => {
  assert.doesNotThrow(() => assertSafeContent('const count = 42;\n// public example\n'));
  assert.doesNotThrow(() => assertSafeContent('api_key = "<YOUR_KEY>"'));
  const value = 'safe source fixture\n';
  assert.equal(hashText(value), crypto.createHash('sha256').update(value, 'utf8').digest('hex'));
  assert.notEqual(hashText(value), hashText(value + '\n'));
});

test('filesystem errors do not disclose absolute host paths', async t => {
  const { root, workspace } = await fixture(t);
  await assert.rejects(resolvePath(workspace, 'src/missing.txt'), error => {
    safeFailure(error);
    assert.ok(!error.message.includes(root));
    assert.ok(!error.message.includes(os.homedir()));
    return true;
  });
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function fixtureVsix(extra = []) {
  const entries = [
    ['extension.vsixmanifest', '<PackageManifest/>'],
    ['extension/package.json', JSON.stringify({ name: 'public-fixture', version: '0.0.0', publisher: 'example' })],
    ['extension/dist/extension.js', 'module.exports = {};\n'],
    ...extra,
  ];
  const locals = [], central = [];
  let position = 0;
  for (const [filename, text] of entries) {
    const name = Buffer.from(filename);
    const data = Buffer.from(text);
    const compressed = zlib.deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(position, 42);
    locals.push(local, name, compressed);
    central.push(directory, name);
    position += local.length + name.length + compressed.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(position, 16);
  return Buffer.concat([...locals, centralData, end]);
}

async function scanArchive(t, extra, privatePattern = '') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-publication-scan-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.vsix');
  await fs.writeFile(file, fixtureVsix(extra));
  try {
    const output = await execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'privacy-scan.js'), '--vsix', file], {
      env: { ...process.env, PRIVACY_BLOCK_PATTERNS: privatePattern }, windowsHide: true,
    });
    return { code: 0, output: output.stdout + output.stderr };
  } catch (error) {
    return { code: error.code, output: String(error.stdout || '') + String(error.stderr || '') };
  }
}

test('privacy scanner inspects decompressed VSIX source and accepts clean packages', async t => {
  const result = await scanArchive(t, [['extension/README.md', 'secret = "YOUR_EXAMPLE_KEY"\n']]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /including VSIX contents/);
});

test('privacy scanner blocks packaged credentials without echoing their values', async t => {
  const fabricated = 'ghp_' + 'a1'.repeat(24);
  const result = await scanArchive(t, [['extension/dist/private.js', `const value = "${fabricated}";`]]);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /provider token/);
  assert.ok(!result.output.includes(fabricated));
});

test('privacy scanner blocks private files and unsafe archive paths', async t => {
  for (const filename of ['extension/.env', 'extension/runtime/state.json', 'extension/app.log', 'extension/../outside.txt']) {
    const result = await scanArchive(t, [[filename, 'public fixture content']]);
    assert.notEqual(result.code, 0, filename);
    assert.match(result.output, /environment file|runtime|log, credential|unsafe archive/);
  }
});

test('privacy scanner detects escaped Windows paths and injected private patterns', async t => {
  const personalPath = 'C' + ':' + '\\\\Users\\\\fixture\\\\private';
  const pathResult = await scanArchive(t, [['extension/README.md', personalPath]]);
  assert.notEqual(pathResult.code, 0);
  assert.match(pathResult.output, /personal absolute Windows path/);
  assert.ok(!pathResult.output.includes(personalPath));
  const privateMarker = 'PRIVATE_PUBLISHING_MARKER_' + 'a1'.repeat(4);
  const patternResult = await scanArchive(t, [['extension/README.md', privateMarker]], privateMarker);
  assert.notEqual(patternResult.code, 0);
  assert.match(patternResult.output, /private pattern 1/);
  assert.ok(!patternResult.output.includes(privateMarker));
});

test('rejected unauthenticated requests cannot exhaust the authenticated request quota', async t => {
  const http = require('node:http');
  const { startServer } = require('../src/server');
  const secret = crypto.randomBytes(32).toString('hex');
  const bridge = await startServer({ host: {}, token: secret, port: 0 });
  t.after(() => bridge.close());
  const request = authenticated => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: bridge.port, path: '/health',
      headers: authenticated ? { Authorization: `Bearer ${secret}` } : {},
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
  });
  for (let i = 0; i < 241; i++) await request(false);
  assert.equal(await request(true), 200);
});

test('file traversal does not load an oversized ignore file before checking its size', async t => {
  const { root, workspace } = await fixture(t);
  const ignorePath = path.join(root, '.gitignore');
  await fs.writeFile(ignorePath, '# harmless oversized ignore fixture\n'.repeat(3000));
  const originalRead = fs.readFile;
  let readOversized = false;
  t.mock.method(fs, 'readFile', function (filename, ...args) {
    if (String(filename) === ignorePath) readOversized = true;
    return originalRead.call(this, filename, ...args);
  });
  const { walkFiles } = require('../src/tools');
  const result = await walkFiles(workspace, 0, '');
  assert.ok(result.files.includes('src/public.txt'));
  assert.equal(readOversized, false, 'The size check must happen before allocating the ignore file contents');
});

test('ignore files cannot read through an external hard link', async t => {
  const { root, outside, workspace } = await fixture(t);
  const externalIgnore = path.join(outside, 'public-ignore-fixture.txt');
  await fs.writeFile(externalIgnore, 'src/public.txt\n');
  try { await fs.link(externalIgnore, path.join(root, '.gitignore')); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'EXDEV'].includes(error.code)) return t.skip('The environment cannot create a hard link');
    throw error;
  }
  const { walkFiles } = require('../src/tools');
  const result = await walkFiles(workspace, 0, '');
  assert.ok(result.files.includes('src/public.txt'), 'Excluded links must not affect the workspace ignore policy');
});

test('editor reads reject a directory switched to a junction during document loading', async t => {
  const { root, outside } = await fixture(t);
  await fs.writeFile(path.join(outside, 'public.txt'), 'outside fixture content');
  const probe = path.join(root, 'probe-link');
  try {
    await fs.symlink(outside, probe, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.unlink(probe);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('The environment cannot create a link');
    throw error;
  }
  const { createVscodeHost } = require('../src/vscode-host');
  const vscode = {
    env: { language: 'en' },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    workspace: {
      isTrusted: true, name: 'fixture', workspaceFolders: [{ name: 'fixture', uri: { scheme: 'file', fsPath: root } }],
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      async openTextDocument(uri) {
        await fs.rename(path.join(root, 'src'), path.join(root, 'original-src'));
        await fs.symlink(outside, path.join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
        const text = await fs.readFile(uri.fsPath, 'utf8');
        return { getText: () => text, version: 1, isDirty: false };
      },
    },
    window: { tabGroups: { all: [], close: async () => true } },
  };
  const host = createVscodeHost({ vscode, getAccess: () => ({ read: true }) });
  t.after(() => host.dispose());
  await assert.rejects(host.readDocument({ path: path.join(root, 'src', 'public.txt'), workspaceId: host.getWorkspace().id }), safeFailure);
});
