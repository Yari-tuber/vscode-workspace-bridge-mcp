'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { definitions } = require('../src/git-tools');
const exec = promisify(execFile);
const executable = process.platform === 'win32' ? path.join(process.env.ProgramFiles || path.join('C:' + path.sep, 'Program Files'), 'Git', 'cmd', 'git.exe') : '/usr/bin/git';

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-bridge-git-test-')));
  const root = path.join(temporary, 'repo'); const template = path.join(temporary, 'template');
  await fs.mkdir(root); await fs.mkdir(template);
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const git = async (...args) => (await exec(executable, ['-C', root, ...args], { windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temporary, 'empty-config'), GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  await fs.writeFile(path.join(temporary, 'empty-config'), '');
  await git('init', '--initial-branch=main', `--template=${template}`);
  await git('config', 'user.name', 'Fixture Author'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'core.autocrlf', 'false');
  const context = { workspace: { id: 'git-workspace', trusted: true, roots: [{ path: root }] }, access: { read: true, git: true }, approvals: [], approve: true };
  const host = { getWorkspace: () => context.workspace, getAccess: () => context.access, getGitExecutable: () => executable, confirmAction: async action => { context.approvals.push(action); return typeof context.approve === 'function' ? context.approve(action) : context.approve; } };
  const call = (name, input = {}) => { const definition = definitions.find(item => item.name === name); const args = definition.schema.parse({ workspaceId: context.workspace.id, ...input }); return definition.run(host, context.workspace, args); };
  const write = (name, text) => fs.writeFile(path.join(root, name), text);
  const stage = async paths => call('git_stage', { paths, expectedStateHash: (await call('git_status')).stateHash });
  const commit = async message => call('git_commit', { message, expectedReviewHash: (await call('git_diff', { staged: true })).reviewHash });
  return { temporary, root, git, context, host, call, write, stage, commit };
}

test('Git tools inspect, stage two exact files, review and commit an unborn repository', async t => {
  const f = await fixture(t); await f.write('one.txt', 'one\n'); await f.write('two.txt', 'two\n');
  const status = await f.call('git_status'); assert.equal(status.head, null); assert.equal(status.branch, 'main'); assert.equal(status.files.length, 2);
  await f.stage(['one.txt', 'two.txt']);
  const review = await f.call('git_diff', { staged: true }); assert.match(review.patch, /\+one/); assert.match(review.patch, /\+two/); assert.match(review.reviewHash, /^[a-f0-9]{64}$/);
  const result = await f.call('git_commit', { message: 'Add two fixture files', expectedReviewHash: review.reviewHash });
  assert.equal(result.committed, true); assert.equal(await f.git('show', 'HEAD:one.txt'), 'one'); assert.equal(await f.git('status', '--porcelain'), '');
  assert.equal(f.context.approvals.length, 2); assert.equal(result.signed, false);
  const log = await f.call('git_log'); assert.equal(log.commits[0].subject, 'Add two fixture files'); assert.equal(JSON.stringify(log).includes('fixture@example.invalid'), false);
});

test('Git unstaging restores only selected entries and preserves working text', async t => {
  const f = await fixture(t); await f.write('one.txt', 'before\n'); await f.stage(['one.txt']); await f.commit('Initial fixture');
  await f.write('one.txt', 'after\n'); await f.write('two.txt', 'new\n'); await f.stage(['one.txt', 'two.txt']);
  const status = await f.call('git_status'); const result = await f.call('git_unstage', { paths: ['one.txt'], expectedStateHash: status.stateHash });
  assert.deepEqual(result.unstaged, ['one.txt']); assert.equal(await f.git('show', ':one.txt'), 'before'); assert.equal(await fs.readFile(path.join(f.root, 'one.txt'), 'utf8'), 'after\n'); assert.match(await f.git('diff', '--cached', '--name-only'), /two.txt/);
});

test('Git unstaging an unborn file removes its index entry only', async t => {
  const f = await fixture(t); await f.write('one.txt', 'new\n'); await f.stage(['one.txt']);
  await f.call('git_unstage', { paths: ['one.txt'], expectedStateHash: (await f.call('git_status')).stateHash });
  assert.equal(await f.git('ls-files'), ''); assert.equal(await fs.readFile(path.join(f.root, 'one.txt'), 'utf8'), 'new\n');
});

test('Git staging and committing require a local capability and exact true approval', async t => {
  const f = await fixture(t); await f.write('one.txt', 'one\n'); const state = (await f.call('git_status')).stateHash;
  f.context.access.git = false;
  await assert.rejects(f.call('git_stage', { paths: ['one.txt'], expectedStateHash: state }), { code: 'ACCESS_DENIED' });
  f.context.access.git = true; f.context.approve = false;
  await assert.rejects(f.call('git_stage', { paths: ['one.txt'], expectedStateHash: state }), { code: 'ACTION_DECLINED' }); assert.equal(await f.git('ls-files'), '');
  f.context.approve = true; await f.stage(['one.txt']); const review = await f.call('git_diff', { staged: true }); f.context.approve = false;
  await assert.rejects(f.call('git_commit', { message: 'Declined', expectedReviewHash: review.reviewHash }), { code: 'ACTION_DECLINED' }); assert.equal((await f.call('git_status')).head, null);
});

test('Git state fingerprints reject working-file mutations before and during local approval', async t => {
  const f = await fixture(t); await f.write('one.txt', 'before\n'); const old = (await f.call('git_status')).stateHash; await f.write('one.txt', 'after\n');
  await assert.rejects(f.call('git_stage', { paths: ['one.txt'], expectedStateHash: old }), { code: 'GIT_STATE_CHANGED' });
  f.context.approve = async () => { await f.write('one.txt', 'changed during approval\n'); return true; };
  await assert.rejects(f.stage(['one.txt']), { code: 'GIT_STATE_CHANGED' }); assert.equal(await f.git('ls-files'), '');
});

test('Git commit rejects staged mutations and never commits an unreviewed index', async t => {
  const f = await fixture(t); await f.write('one.txt', 'one\n'); await f.stage(['one.txt']); const old = await f.call('git_diff', { staged: true });
  await f.write('two.txt', 'two\n'); await f.stage(['two.txt']);
  await assert.rejects(f.call('git_commit', { message: 'Stale review', expectedReviewHash: old.reviewHash }), { code: 'GIT_REVIEW_REQUIRED' }); assert.equal((await f.call('git_status')).head, null);
});

test('Git hides sensitive path names and refuses hidden or credential staged content', async t => {
  const f = await fixture(t); await f.write('.env', 'LOCAL_CONFIGURATION=value\n'); await f.write('one.txt', 'safe\n');
  const status = await f.call('git_status'); assert.equal(status.hiddenFileCount, 1); assert.equal(JSON.stringify(status).includes('.env'), false);
  await assert.rejects(f.call('git_stage', { paths: ['.env'], expectedStateHash: status.stateHash }), { code: 'UNSAFE_PATH' });
  await f.git('add', '.env'); await f.stage(['one.txt']); const review = await f.call('git_diff', { staged: true }); assert.equal(review.reviewHash, null); assert.equal(review.patch.includes('.env'), false);
  await assert.rejects(f.call('git_commit', { message: 'Unsafe', expectedReviewHash: '1'.repeat(64) }), { code: 'GIT_REVIEW_REQUIRED' });
  await f.git('rm', '--cached', '.env'); await f.write('one.txt', 'api_key = "' + 'a'.repeat(24) + '"\n');
  await assert.rejects(f.stage(['one.txt']), { code: 'SENSITIVE_CONTENT' });
});

test('Git bypasses clean filters, fsmonitor hooks, pre-commit and reference hooks', async t => {
  const f = await fixture(t); const marker = path.join(f.root, 'hook-ran.txt').replaceAll('\\', '/');
  await f.git('config', 'filter.evil.clean', `echo called > '${marker}'`); await f.git('config', 'filter.evil.required', 'true'); await f.git('config', 'core.fsmonitor', `echo called > '${marker}'`);
  await f.write('.gitattributes', '*.txt filter=evil\n'); await f.write('one.txt', 'raw unchanged\r\n');
  for (const name of ['pre-commit', 'post-commit', 'post-index-change', 'reference-transaction']) { const hook = path.join(f.root, '.git', 'hooks', name); await fs.mkdir(path.dirname(hook), { recursive: true }); await fs.writeFile(hook, `#!/bin/sh\necho called > '${marker}'\nexit 1\n`); await fs.chmod(hook, 0o755); }
  await f.stage(['one.txt']); await f.commit('No hooks should execute');
  await assert.rejects(fs.stat(path.join(f.root, 'hook-ran.txt')), { code: 'ENOENT' });
  assert.equal((await exec(executable, ['-C', f.root, '-c', 'core.fsmonitor=false', 'show', 'HEAD:one.txt'], { encoding: 'buffer' })).stdout.toString('utf8'), 'raw unchanged\r\n');
});

test('Git diff disables external diff and textconv commands', async t => {
  const f = await fixture(t); await f.write('one.txt', 'before\n'); await f.stage(['one.txt']); await f.commit('Fixture');
  const marker = path.join(f.root, 'external-ran.txt').replaceAll('\\', '/');
  await f.write('.gitattributes', '*.txt diff=evil\n'); await f.git('config', 'diff.evil.command', `echo called > '${marker}'`); await f.git('config', 'diff.evil.textconv', `echo called > '${marker}'`); await f.write('one.txt', 'after\n');
  const result = await f.call('git_diff'); assert.match(result.patch, /\+after/); await assert.rejects(fs.stat(path.join(f.root, 'external-ran.txt')), { code: 'ENOENT' });
});

test('Git rejects config includes, external worktree pointers and subfolder roots', async t => {
  const f = await fixture(t); await f.git('config', 'include.path', path.join(f.temporary, 'outside-config'));
  await assert.rejects(f.call('git_status'), { code: 'GIT_CONFIGURATION_UNSAFE' }); await f.git('config', '--unset', 'include.path');
  await fs.mkdir(path.join(f.root, 'nested')); f.context.workspace.roots[0].path = path.join(f.root, 'nested');
  await assert.rejects(f.call('git_status'), { code: 'GIT_REPOSITORY_REQUIRED' });
  await fs.writeFile(path.join(f.root, 'nested', '.git'), `gitdir: ${path.join(f.root, '.git')}\n`);
  await assert.rejects(f.call('git_status'), { code: 'GIT_EXTERNAL_METADATA' });
});

test('Git accepts an internal .git directory pointer and rejects external alternates', async t => {
  const f = await fixture(t); await fs.rename(path.join(f.root, '.git'), path.join(f.root, '.metadata')); await fs.writeFile(path.join(f.root, '.git'), 'gitdir: .metadata\n');
  assert.equal((await f.call('git_status')).branch, 'main');
  await fs.mkdir(path.join(f.root, '.metadata', 'objects', 'info'), { recursive: true }); await fs.writeFile(path.join(f.root, '.metadata', 'objects', 'info', 'alternates'), f.temporary + '\n');
  await assert.rejects(f.call('git_status'), { code: 'GIT_EXTERNAL_METADATA' });
});

test('Git deletion staging and selective unstaging do not remove working data', async t => {
  const f = await fixture(t); await f.write('one.txt', 'one\n'); await f.stage(['one.txt']); await f.commit('Initial'); await fs.unlink(path.join(f.root, 'one.txt'));
  await f.stage(['one.txt']); assert.match((await f.call('git_diff', { staged: true })).patch, /deleted file/);
  await f.call('git_unstage', { paths: ['one.txt'], expectedStateHash: (await f.call('git_status')).stateHash }); assert.equal(await f.git('show', ':one.txt'), 'one'); await assert.rejects(fs.stat(path.join(f.root, 'one.txt')), { code: 'ENOENT' });
});

test('Git fails closed on merge conflicts and never returns author emails in history', async t => {
  const f = await fixture(t); await f.write('one.txt', 'base\n'); await f.stage(['one.txt']); await f.commit('Base'); await f.git('checkout', '-b', 'side'); await f.write('one.txt', 'side\n'); await f.git('add', 'one.txt'); await f.git('commit', '-m', 'Side fixture@example.invalid'); await f.git('checkout', 'main'); await f.write('one.txt', 'main\n'); await f.git('add', 'one.txt'); await f.git('commit', '-m', 'Main');
  await assert.rejects(f.git('merge', 'side'));
  const status = await f.call('git_status'); assert.equal(status.files.some(file => file.conflict), true);
  await assert.rejects(f.call('git_stage', { paths: ['one.txt'], expectedStateHash: status.stateHash }), { code: 'GIT_CONFLICT' }); assert.equal(JSON.stringify(await f.call('git_log')).includes('fixture@example.invalid'), false);
});

test('Git requires a local identity for commit without exposing its configured email', async t => {
  const f = await fixture(t); await f.write('one.txt', 'one\n'); await f.stage(['one.txt']); await f.git('config', '--unset', 'user.email');
  await assert.rejects(f.commit('Missing identity'), { code: 'GIT_IDENTITY_REQUIRED' }); assert.equal(f.context.approvals.length, 1);
});

test('Git complete staged review is mandatory and truncated patches cannot be committed', async t => {
  const f = await fixture(t); await f.write('large.txt', 'large line\n'.repeat(7000)); await f.stage(['large.txt']); const review = await f.call('git_diff', { staged: true }); assert.equal(review.truncated, true); assert.equal(review.reviewHash, null);
  await assert.rejects(f.call('git_commit', { message: 'Too large to review', expectedReviewHash: '0'.repeat(64) }), { code: 'GIT_REVIEW_REQUIRED' });
});

test('Git rejects binary staged files, unsafe paths and arbitrary schema parameters', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'one.txt'), Buffer.from([0xff, 0xfe, 0x61])); await assert.rejects(f.stage(['one.txt']), { code: 'BINARY_CONTENT' });
  await f.git('add', 'one.txt'); await assert.rejects(f.call('git_diff', { staged: true }), { code: 'BINARY_CONTENT' });
  const status = await f.call('git_status'); await assert.rejects(f.call('git_stage', { paths: ['../outside'], expectedStateHash: status.stateHash }), { code: 'UNSAFE_PATH' });
  assert.throws(() => definitions.find(item => item.name === 'git_status').schema.parse({ workspaceId: 'git-workspace', args: ['--help'] }));
});

test('Git refuses a workspace-contained Git executable before spawning it', async t => {
  const f = await fixture(t); const wrapper = path.join(f.root, process.platform === 'win32' ? 'git.exe' : 'git');
  await fs.writeFile(wrapper, '#!/bin/sh\ntouch marker.txt\n'); await fs.chmod(wrapper, 0o755);
  f.host.getGitExecutable = () => wrapper;
  await assert.rejects(f.call('git_status'), { code: 'GIT_UNAVAILABLE' });
  await assert.rejects(fs.stat(path.join(f.root, 'marker.txt')), { code: 'ENOENT' });
});

test('Git rejects control characters in filter subsection names before running status', async t => {
  const f = await fixture(t); await f.git('config', 'filter.evil\tname.clean', 'echo unwanted');
  await assert.rejects(f.call('git_status'), { code: 'GIT_CONFIGURATION_UNSAFE' });
});

test('Git grant revocation during local approval prevents staging', async t => {
  const f = await fixture(t); await f.write('one.txt', 'one\n');
  f.context.approve = async () => { f.context.access.git = false; return true; };
  await assert.rejects(f.stage(['one.txt']), { code: 'ACCESS_DENIED' }); assert.equal(await f.git('ls-files'), '');
});
