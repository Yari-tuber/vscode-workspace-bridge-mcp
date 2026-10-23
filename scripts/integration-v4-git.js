'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createVscodeHost } = require('../src/vscode-host');
const { startServer } = require('../src/server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const exec = promisify(execFile);

async function run({ vscode, root, check }) {
  const realRoot = await fs.realpath(root); const tempRoot = await fs.realpath(os.tmpdir()); const relative = path.relative(tempRoot, realRoot);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.ok(relative.split(path.sep).some(part => part.startsWith('workspace-bridge-integration-')));
  await assert.rejects(fs.lstat(path.join(realRoot, '.git')), { code: 'ENOENT' });
  const prefix = `bridge-git-v4-${crypto.randomBytes(5).toString('hex')}`;
  const filenames = [`${prefix}-one.txt`, `${prefix}-two.txt`];
  const access = { read: true, edit: true, terminal: true, git: false, refactor: false, tasks: false };
  const approvals = [];
  const controlledVscode = Object.create(vscode);
  Object.defineProperty(controlledVscode, 'window', { value: Object.create(vscode.window) });
  Object.defineProperty(controlledVscode.window, 'showWarningMessage', { value: async (title, options, ...buttons) => {
    assert.match(title, /Stage reviewed Git files|Unstage reviewed Git files|Commit reviewed Git changes/);
    assert.equal(options.modal, true); assert.ok(options.detail.includes(prefix)); assert.equal(buttons.length, 1);
    approvals.push({ title, detail: options.detail }); return buttons[0];
  } });
  const host = createVscodeHost({ vscode: controlledVscode, getAccess: () => access });
  const support = await fs.mkdtemp(path.join(tempRoot, 'workspace-bridge-git-runtime-'));
  let server, client;
  try {
    const executable = await host.getGitExecutable(); assert.ok(executable && path.isAbsolute(executable));
    const config = path.join(support, 'empty-config'); const template = path.join(support, 'empty-template');
    await fs.writeFile(config, ''); await fs.mkdir(template);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0' });
    const git = async (...args) => (await exec(executable, ['-C', realRoot, ...args], { env, windowsHide: true })).stdout.trim();
    await git('init', '--initial-branch=bridge-runtime', `--template=${template}`);
    await git('config', 'user.name', 'Bridge Runtime Fixture'); await git('config', 'user.email', 'bridge-fixture@example.invalid'); await git('config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(realRoot, filenames[0]), 'First Git runtime file.\n'); await fs.writeFile(path.join(realRoot, filenames[1]), 'Second Git runtime file.\n');
    const token = crypto.randomBytes(32).toString('hex'); server = await startServer({ host, token, port: 0 });
    client = new Client({ name: 'git-v4-runtime-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const unpack = response => { if (response.isError) throw new Error(response.content[0].text); return JSON.parse(response.content[0].text); };
    const overview = unpack(await client.callTool({ name: 'workspace_overview', arguments: {} })); const scope = { workspaceId: overview.workspaceId };
    const raw = (name, input = {}) => client.callTool({ name, arguments: { ...scope, ...input } });
    const call = async (name, input = {}) => unpack(await raw(name, input));
    await check('v4 real Git status is read-only while independent Git writes remain denied over MCP', async () => {
      const status = await call('git_status'); assert.equal(status.branch, 'bridge-runtime'); assert.equal(status.head, null); assert.ok(status.files.some(file => file.path === filenames[0]));
      assert.equal(JSON.stringify(status).includes(realRoot), false);
      const denied = await raw('git_stage', { paths: filenames, expectedStateHash: status.stateHash });
      assert.equal(denied.isError, true); assert.match(denied.content[0].text, /ACCESS_DENIED/); assert.equal(approvals.length, 0); assert.equal(await git('ls-files'), '');
    });
    access.git = true;
    await check('v4 real Git staging rejects a stale content fingerprint before confirmation', async () => {
      const snapshot = await call('git_status'); await fs.appendFile(path.join(realRoot, filenames[0]), 'Changed after status.\n');
      const rejected = await raw('git_stage', { paths: filenames, expectedStateHash: snapshot.stateHash });
      assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /GIT_STATE_CHANGED/); assert.equal(approvals.length, 0); assert.equal(await git('ls-files'), '');
    });
    let review;
    await check('v4 real Git stages only named files and returns a complete staged patch over MCP', async () => {
      const snapshot = await call('git_status'); const staged = await call('git_stage', { paths: filenames, expectedStateHash: snapshot.stateHash });
      assert.deepEqual(staged.staged, filenames); assert.equal(approvals.length, 1);
      assert.deepEqual((await git('ls-files')).split(/\r?\n/), [...filenames].sort());
      review = await call('git_diff', { staged: true }); assert.match(review.reviewHash, /^[a-f0-9]{64}$/); assert.equal(review.truncated, false); assert.match(review.patch, /Changed after status/); assert.equal(JSON.stringify(review).includes(realRoot), false);
    });
    await check('v4 real Git commits only the reviewed index and history excludes author identity', async () => {
      const result = await call('git_commit', { expectedReviewHash: review.reviewHash, message: 'Bridge v4 runtime fixture' });
      assert.equal(result.committed, true); assert.deepEqual(result.paths, [...filenames].sort()); assert.equal(result.hash, await git('rev-parse', 'HEAD')); assert.equal(approvals.length, 2);
      const history = await call('git_log'); assert.equal(history.commits[0].subject, 'Bridge v4 runtime fixture'); assert.equal(JSON.stringify(history).includes('bridge-fixture@example.invalid'), false); assert.equal(JSON.stringify(history).includes(realRoot), false);
    });
    await check('v4 real Git selective unstaging preserves the changed working file', async () => {
      const changed = 'Working text retained after unstage.\n'; await fs.writeFile(path.join(realRoot, filenames[0]), changed);
      const snapshot = await call('git_status'); await call('git_stage', { paths: [filenames[0]], expectedStateHash: snapshot.stateHash });
      const staged = await call('git_status'); const result = await call('git_unstage', { paths: [filenames[0]], expectedStateHash: staged.stateHash });
      assert.deepEqual(result.unstaged, [filenames[0]]); assert.equal(await git('diff', '--cached', '--name-only'), ''); assert.equal(await fs.readFile(path.join(realRoot, filenames[0]), 'utf8'), changed); assert.equal(approvals.length, 4);
    });
  } finally {
    if (client) await client.close(); if (server) await server.close(); host.dispose(); await fs.rm(support, { recursive: true, force: true });
  }
}
module.exports = { run };
