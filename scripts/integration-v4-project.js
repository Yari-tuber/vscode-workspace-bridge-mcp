'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createVscodeHost } = require('../src/vscode-host');
const { startServer } = require('../src/server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

async function run({ vscode, root, check }) {
  const manifestPath = path.join(root, 'package.json');
  const passingFile = path.join(root, 'bridge-project-pass.test.cjs');
  const failingFile = path.join(root, 'bridge-project-fail.test.cjs');
  const saved = new Map();
  for (const file of [manifestPath, passingFile, failingFile]) {
    try { saved.set(file, await fs.readFile(file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; saved.set(file, undefined); }
  }
  const scripts = {
    'bridge-pass': 'node --test --test-reporter=tap bridge-project-pass.test.cjs',
    'bridge-fail': 'node --test --test-reporter=tap bridge-project-fail.test.cjs',
  };
  const writeManifest = () => fs.writeFile(manifestPath, JSON.stringify({ name: 'bridge-isolated-runtime-fixture', private: true, scripts }, null, 2));
  const access = { read: true, edit: false, terminal: true, tasks: false };
  const approvals = [];
  let approvalMode = 'session';
  const testVscode = Object.create(vscode);
  Object.defineProperty(testVscode, 'window', { value: Object.create(vscode.window) });
  Object.defineProperty(testVscode.window, 'showWarningMessage', { value: async (message, options, ...actions) => {
    assert.match(options.detail, /node --test --test-reporter=tap/);
    assert.match(options.detail, /not a sandbox|不在沙箱/);
    assert.equal(actions.length, 2);
    approvals.push({ message, detail: options.detail });
    return approvalMode === 'session' ? actions[1] : actions[0];
  } });
  let host, server, client;
  try {
    await writeManifest();
    await fs.writeFile(passingFile, "const test = require('node:test'); test('bridge runtime passing check', () => {});\n");
    await fs.writeFile(failingFile, "const test = require('node:test'); const assert = require('node:assert/strict'); test('bridge runtime passing check', () => {}); test('bridge runtime intended failure', () => assert.equal(1, 2));\n");
    host = createVscodeHost({ vscode: testVscode, getAccess: () => access });
    const token = crypto.randomBytes(32).toString('hex');
    server = await startServer({ host, token, port: 0 });
    client = new Client({ name: 'project-tasks-v4-runtime', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const data = response => {
      if (response.isError) throw new Error(response.content[0].text);
      return JSON.parse(response.content[0].text);
    };
    const overview = data(await client.callTool({ name: 'workspace_overview', arguments: {} }));
    const scope = { workspaceId: overview.workspaceId };
    const call = async (name, args = {}) => client.callTool({ name, arguments: { ...scope, ...args } });
    let listed;
    const poll = async id => {
      let result;
      const deadline = Date.now() + 20000;
      do {
        await new Promise(resolve => setTimeout(resolve, 50));
        result = data(await call('get_project_task', { id }));
      } while (['awaiting_approval', 'running', 'stopping'].includes(result.state) && Date.now() < deadline);
      assert.equal(['awaiting_approval', 'running', 'stopping'].includes(result.state), false, 'Project task did not finish in the runtime fixture.');
      return result;
    };
    await check('project tasks list script names without commands and require separate execution access', async () => {
      listed = data(await call('list_project_tasks'));
      assert.deepEqual(listed.tasks.map(task => task.name), ['bridge-fail', 'bridge-pass']);
      assert.equal(JSON.stringify(listed).includes('node --test'), false);
      const denied = await call('run_project_task', { taskName: 'bridge-pass', manifestHash: listed.manifestHash });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /ACCESS_DENIED/);
      assert.equal(approvals.length, 0);
    });
    access.tasks = true;
    access.terminal = false;
    await check('real npm project task reports passing TAP counts without exposing raw output', async () => {
      const job = data(await call('run_project_task', { taskName: 'bridge-pass', manifestHash: listed.manifestHash, timeoutMs: 15000 }));
      assert.equal(job.state, 'awaiting_approval');
      const result = await poll(job.id);
      assert.equal(result.state, 'completed');
      assert.equal(result.testSummary.status, 'passed');
      assert.equal(result.testSummary.counts.tests, 1);
      assert.equal(result.testSummary.counts.pass, 1);
      assert.equal(Object.hasOwn(result, 'output'), false);
      assert.equal(approvals.length, 1);
      assert.equal(Object.hasOwn(result, 'command'), false);
      assert.equal(Object.hasOwn(result, 'cwd'), false);
    });
    await check('locally authorized same-session project task repeats without another modal', async () => {
      const job = data(await call('run_project_task', { taskName: 'bridge-pass', manifestHash: listed.manifestHash, timeoutMs: 15000 }));
      const result = await poll(job.id);
      assert.equal(result.testSummary.status, 'passed');
      assert.equal(approvals.length, 1);
    });
    approvalMode = 'once';
    await check('real failing npm project task returns bounded failed names and accurate counts', async () => {
      const job = data(await call('run_project_task', { taskName: 'bridge-fail', manifestHash: listed.manifestHash, timeoutMs: 15000 }));
      const result = await poll(job.id);
      assert.equal(result.state, 'failed');
      assert.equal(result.exitCode, 1);
      assert.equal(result.testSummary.status, 'failed');
      assert.equal(result.testSummary.counts.tests, 2);
      assert.equal(result.testSummary.counts.pass, 1);
      assert.equal(result.testSummary.counts.fail, 1);
      assert.deepEqual(result.testSummary.failedNames, ['bridge runtime intended failure']);
      assert.equal(Object.hasOwn(result, 'output'), false);
      assert.equal(approvals.length, 2);
    });
    await check('manifest changes reject stale task requests and require fresh local approval', async () => {
      scripts['bridge-pass'] += ' ';
      await writeManifest();
      const stale = await call('run_project_task', { taskName: 'bridge-pass', manifestHash: listed.manifestHash });
      assert.equal(stale.isError, true);
      assert.match(stale.content[0].text, /MANIFEST_CHANGED/);
      assert.equal(approvals.length, 2);
      const fresh = data(await call('list_project_tasks'));
      assert.notEqual(fresh.manifestHash, listed.manifestHash);
      const job = data(await call('run_project_task', { taskName: 'bridge-pass', manifestHash: fresh.manifestHash, timeoutMs: 15000 }));
      assert.equal((await poll(job.id)).testSummary.status, 'passed');
      assert.equal(approvals.length, 3);
    });
  } finally {
    if (client) await client.close();
    if (server) await server.close();
    host?.dispose();
    for (const [file, contents] of saved) {
      if (contents === undefined) await fs.rm(file, { force: true });
      else await fs.writeFile(file, contents);
    }
  }
}

module.exports = { run };
