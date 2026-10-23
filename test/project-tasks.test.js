'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createProjectTasks, summarizeTests } = require('../src/project-tasks');
const { definitions } = require('../src/project-task-tools');
const { hashText } = require('../src/security');
const { createTaskManager } = require('../src/task-manager');

async function fixture(t, scripts = { test: 'node --test', build: 'node build.js' }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-bridge-project-')));
  const context = { workspace: { id: 'project-session', trusted: true, roots: [{ path: root }] }, access: { read: true, tasks: true }, started: [] };
  const write = value => fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: value }));
  await write(scripts);
  const project = createProjectTasks({ getWorkspace: () => context.workspace, getAccess: () => context.access,
    startTask: input => { context.started.push(input); return { id: 'a'.repeat(32), state: 'awaiting_approval' }; },
    getTask: () => ({ id: 'a'.repeat(32), state: 'completed', exitCode: 0, output: 'unknown reporter', outputWithheld: false }) });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = { workspaceId: context.workspace.id };
  return { root, context, project, input, write };
}

test('listing exposes only safe script names and manifest hash, never command text or absolute paths', async t => {
  const f = await fixture(t, { test: 'node --test', build: 'echo private build text', 'bad;echo': 'unsafe', 'invalid/name': 'node test.js', empty: '', notText: 42 });
  f.context.access.tasks = false;
  const result = await f.project.list(f.input);
  assert.deepEqual(result.tasks, [{ name: 'build' }, { name: 'test' }]);
  assert.match(result.manifestHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('private build text'), false);
  assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(f.context.started.length, 0);
});

test('run binds a task to manifest, supplies local-only full approval data, and never accepts shell syntax', async t => {
  const f = await fixture(t, { test: 'node --test', pretest: 'node setup.js', posttest: 'node teardown.js' });
  const listed = await f.project.list(f.input);
  const result = await f.project.run({ ...f.input, taskName: 'test', manifestHash: listed.manifestHash });
  assert.equal(result.state, 'awaiting_approval');
  const request = f.context.started[0];
  assert.equal(request.command, 'npm run -- test');
  assert.equal(request.approval.script, 'node --test');
  assert.deepEqual(request.approval.lifecycleScripts.map(value => value.name), ['pretest', 'posttest']);
  assert.equal(request.timeoutMs, 120000);
  await request.beforeLaunch();
  await assert.rejects(f.project.run({ ...f.input, taskName: 'test;echo injected', manifestHash: listed.manifestHash }), { code: 'INVALID_TASK_NAME' });
  await assert.rejects(f.project.run({ ...f.input, taskName: 'other', manifestHash: listed.manifestHash }), { code: 'PROJECT_TASK_NOT_FOUND' });
  await assert.rejects(f.project.run({ ...f.input, taskName: 'test' }), { code: 'MANIFEST_REQUIRED' });
});

test('project execution requires separate tasks permission, workspace identity and trust', async t => {
  const f = await fixture(t);
  const listed = await f.project.list(f.input);
  const run = () => f.project.run({ ...f.input, taskName: 'test', manifestHash: listed.manifestHash });
  f.context.access.tasks = false;
  await assert.rejects(run(), { code: 'ACCESS_DENIED' });
  f.context.access.tasks = true;
  f.context.workspace.trusted = false;
  await assert.rejects(run(), { code: 'UNTRUSTED_WORKSPACE' });
  f.context.workspace.trusted = true;
  f.context.workspace.id = 'replacement';
  await assert.rejects(run(), { code: 'WORKSPACE_CHANGED' });
  assert.equal(f.context.started.length, 0);
});

test('changed manifests reject before approval and again after the local approval dialog', async t => {
  const f = await fixture(t);
  const listed = await f.project.list(f.input);
  await f.project.run({ ...f.input, taskName: 'test', manifestHash: listed.manifestHash });
  await f.write({ test: 'node changed.js' });
  await assert.rejects(f.context.started[0].beforeLaunch(), { code: 'MANIFEST_CHANGED' });
  await assert.rejects(f.project.run({ ...f.input, taskName: 'test', manifestHash: listed.manifestHash }), { code: 'MANIFEST_CHANGED' });
  assert.equal(f.context.started.length, 1);
});

test('oversized or sensitive lifecycle hooks cannot be hidden from local approval', async t => {
  const f = await fixture(t, { test: 'node --test', pretest: 'x'.repeat(8193) });
  let listed = await f.project.list(f.input);
  await assert.rejects(f.project.run({ ...f.input, taskName: 'test', manifestHash: listed.manifestHash }), { code: 'INVALID_PROJECT_TASK' });
  await f.write({ test: 'node --test', posttest: 'echo ' + 'sk-' + 'A'.repeat(30) });
  listed = await f.project.list(f.input);
  await assert.rejects(f.project.run({ ...f.input, taskName: 'test', manifestHash: listed.manifestHash }), { code: 'SENSITIVE_CONTENT' });
  assert.equal(f.context.started.length, 0);
});

test('invalid JSON, symlinks and oversized manifests never produce project tasks', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'package.json'), '{invalid json');
  await assert.rejects(f.project.list(f.input), { code: 'INVALID_MANIFEST' });
  await fs.writeFile(path.join(f.root, 'package.json'), ' '.repeat(512 * 1024 + 1));
  await assert.rejects(f.project.list(f.input), { code: 'INVALID_MANIFEST' });
  await fs.unlink(path.join(f.root, 'package.json'));
  await fs.writeFile(path.join(f.root, 'real.json'), '{"scripts":{"test":"node --test"}}');
  try { await fs.symlink(path.join(f.root, 'real.json'), path.join(f.root, 'package.json')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  await assert.rejects(f.project.list(f.input), { code: 'SYMLINK_DENIED' });
});

test('summaries recognize only consistent TAP counts and safe bounded failure names', () => {
  const output = 'TAP version 13\nnot ok 1 - first failed test\n# tests 2\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n';
  const result = summarizeTests({ state: 'failed', exitCode: 1, output });
  assert.equal(result.format, 'tap');
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failedNames, ['first failed test']);
  assert.equal(result.counts.tests, 2);
  assert.equal(summarizeTests({ state: 'completed', exitCode: 0, output: 'build done' }).status, 'unknown');
  assert.equal(summarizeTests({ state: 'running', output }).status, 'unknown');
  assert.equal(summarizeTests({ state: 'completed', exitCode: 0, output, outputWithheld: true }).status, 'unknown');
  assert.equal(summarizeTests({ state: 'completed', exitCode: 0, output: output.replace('# pass 1', '# pass 3') }).status, 'unknown');
  assert.equal(summarizeTests({ state: 'completed', exitCode: 0, output: output + '# tests 2\n' }).status, 'unknown');
  assert.equal(summarizeTests({ state: 'completed', exitCode: 0, output: output.replace('# tests 2', '# tests 0').replace('# pass 1', '# pass 0').replace('# fail 1', '# fail 0') }).status, 'unknown');
  assert.equal(summarizeTests({ state: 'completed', exitCode: 0, output: output.replace('# fail 1', '# fail 0').replace('# pass 1', '# pass 2') }).status, 'passed');
});

test('get includes a summary but excludes raw output by default', async t => {
  const f = await fixture(t);
  const result = f.project.get({ ...f.input, id: 'a'.repeat(32) });
  assert.equal(result.testSummary.status, 'unknown');
  assert.equal(Object.hasOwn(result, 'output'), false);
  assert.equal(f.project.get({ ...f.input, id: 'a'.repeat(32), includeOutput: true }).output, 'unknown reporter');
  assert.throws(() => f.project.get({ ...f.input, id: 'a'.repeat(32), includeOutput: 'true' }), { code: 'INVALID_OUTPUT_OPTION' });
});

test('tool schemas expose no arbitrary commands, arguments or internal approval callbacks', () => {
  assert.deepEqual(definitions.map(value => [value.name, value.capability || 'read']), [
    ['list_project_tasks', 'read'], ['run_project_task', 'tasks'], ['get_project_task', 'read']]);
  const run = definitions.find(value => value.name === 'run_project_task');
  const valid = { workspaceId: 'session', taskName: 'test', manifestHash: hashText('{}') };
  assert.equal(run.schema.safeParse(valid).success, true);
  for (const extra of [{ command: 'echo bypass' }, { beforeLaunch: () => {} }, { args: ['--unsafe'] }, { taskName: '--help' }, { timeoutMs: 3_600_001 }]) {
    assert.equal(run.schema.safeParse({ ...valid, ...extra }).success, false);
  }
});

test('an approved real npm task executes only in the temporary project and returns structured failing TAP feedback', async t => {
  const f = await fixture(t, { test: 'node --test --test-reporter=tap sample.test.js' });
  await fs.writeFile(path.join(f.root, 'sample.test.js'), "const test = require('node:test'); const assert = require('node:assert/strict'); test('fixture passes', () => {}); test('fixture fails', () => assert.equal(1, 2));");
  const approvals = [];
  const manager = createTaskManager({ capability: 'tasks', getWorkspace: () => f.context.workspace, getAccess: () => f.context.access,
    checkCwd: async (_workspace, cwd, capability) => {
      assert.equal(capability, 'tasks');
      const real = await fs.realpath(cwd);
      assert.equal(real, f.root);
      return real;
    },
    environment: () => ({ ...process.env, PATH: [path.dirname(process.execPath), process.platform === 'win32' ? path.join(process.env.SystemRoot || path.join(path.parse(process.execPath).root, 'Windows'), 'System32') : '/usr/bin', '/bin'].join(path.delimiter) }),
    confirm: async request => { approvals.push(request); return true; }, checkIntervalMs: 20 });
  t.after(() => manager.dispose());
  const project = createProjectTasks({ getWorkspace: () => f.context.workspace, getAccess: () => f.context.access,
    startTask: input => manager.start(input), getTask: input => manager.get(input) });
  const listed = await project.list(f.input);
  const job = await project.run({ ...f.input, taskName: 'test', manifestHash: listed.manifestHash });
  assert.equal(job.state, 'awaiting_approval');
  const deadline = Date.now() + 10000;
  let result;
  do {
    await new Promise(resolve => setTimeout(resolve, 30));
    result = project.get({ ...f.input, id: job.id });
  } while (['awaiting_approval', 'running', 'stopping'].includes(result.state) && Date.now() < deadline);
  assert.equal(result.state, 'failed');
  assert.equal(result.exitCode, 1);
  assert.equal(result.testSummary.format, 'tap');
  assert.equal(result.testSummary.status, 'failed');
  assert.equal(result.testSummary.counts.tests, 2);
  assert.equal(result.testSummary.counts.pass, 1);
  assert.equal(result.testSummary.counts.fail, 1);
  assert.deepEqual(result.testSummary.failedNames, ['fixture fails']);
  assert.equal(Object.hasOwn(result, 'output'), false);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].approval.script, 'node --test --test-reporter=tap sample.test.js');
  assert.equal(f.context.access.terminal, undefined);
});
