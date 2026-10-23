'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createTaskManager, safeTaskEnvironment, MAX_OUTPUT_BYTES } = require('../src/task-manager');
const { BridgeError, assertSafeContent } = require('../src/security');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(check, message = 'Condition was not reached', timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  assert.fail(message);
}

async function fixture(t, overrides = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-bridge-tasks-')));
  const context = {
    workspace: { id: 'task-test-session', trusted: true, roots: [{ path: root }] },
    access: { read: true, edit: false, terminal: true }, approvals: [], events: [], audits: [], children: [],
  };
  const manager = createTaskManager({
    getWorkspace: () => context.workspace,
    getAccess: () => context.access,
    checkCwd: async (workspace, cwd) => {
      assert.equal(workspace.id, context.workspace.id);
      const canonical = await fs.realpath(cwd);
      if (canonical !== root) throw new BridgeError('OUTSIDE_WORKSPACE', 'Use the fixture workspace.');
      return canonical;
    },
    confirm: async input => { context.approvals.push(input); return false; },
    validateCommand: assertSafeContent,
    onChange: event => context.events.push(event),
    audit: event => context.audits.push(event),
    spawn: (...args) => { const child = childProcess.spawn(...args); context.children.push(child); return child; },
    checkIntervalMs: 20,
    ...overrides,
  });
  t.after(async () => {
    manager.dispose();
    await Promise.all(context.children.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => { child.once('close', resolve); setTimeout(resolve, 2_000).unref(); })));
    await fs.rm(root, { recursive: true, force: true });
  });
  const input = command => ({ workspaceId: context.workspace.id, command, cwd: root });
  const state = job => manager.get({ workspaceId: context.workspace.id, id: job.id });
  const output = job => manager.get({ workspaceId: context.workspace.id, id: job.id, includeOutput: true });
  const script = async source => {
    const name = `fixture-${cryptoId()}.js`;
    await fs.writeFile(path.join(root, name), source);
    return `"${process.execPath}" "${name}"`;
  };
  return { root, manager, context, input, state, output, script };
}

function cryptoId() { return require('node:crypto').randomBytes(5).toString('hex'); }

test('task creation returns awaiting approval immediately and never executes an unapproved command', async t => {
  const pending = deferred();
  const f = await fixture(t, { confirm: () => pending.promise });
  const command = await f.script("require('node:fs').writeFileSync('executed.txt', 'unexpected');");
  const job = await f.manager.start(f.input(command));
  assert.equal(job.state, 'awaiting_approval');
  assert.match(job.id, /^[a-f0-9]{32}$/);
  await delay(80);
  assert.equal(f.context.children.length, 0);
  assert.equal(fsSync.existsSync(path.join(f.root, 'executed.txt')), false);
  pending.resolve(false);
  await until(() => f.state(job).state === 'rejected');
  assert.equal(f.context.children.length, 0);
});

test('late approvals after cancellation or session clearing cannot spawn', async t => {
  const pending = [];
  const f = await fixture(t, { confirm: () => { const request = deferred(); pending.push(request); return request.promise; } });
  const command = await f.script("require('node:fs').writeFileSync('executed.txt', 'unexpected');");
  const cancelled = await f.manager.start(f.input(command));
  await until(() => pending.length === 1);
  assert.equal(f.manager.cancel({ workspaceId: f.context.workspace.id, id: cancelled.id }).state, 'cancelled');
  pending[0].resolve(true);
  await delay(50);
  assert.equal(f.context.children.length, 0);
  const cleared = await f.manager.start(f.input(command));
  await until(() => pending.length === 2);
  f.manager.cancelAll({ clear: true });
  pending[1].resolve(true);
  await delay(50);
  assert.throws(() => f.state(cleared), { code: 'TASK_NOT_FOUND' });
  assert.equal(f.context.children.length, 0);
  assert.equal(fsSync.existsSync(path.join(f.root, 'executed.txt')), false);
});

test('expired approvals cannot be revived and tasks do not wait on the modal', async t => {
  const pending = deferred();
  const f = await fixture(t, { confirm: () => pending.promise, approvalTimeoutMs: 60 });
  const job = await f.manager.start(f.input('echo example'));
  assert.equal(job.state, 'awaiting_approval');
  await until(() => f.state(job).failureCode === 'APPROVAL_EXPIRED');
  pending.resolve(true);
  await delay(50);
  assert.equal(f.state(job).state, 'rejected');
  assert.equal(f.context.children.length, 0);
});

test('approved real subprocess completes; metadata, audit and UI callbacks contain no command, cwd, output or PID', async t => {
  const f = await fixture(t, { confirm: async () => true });
  const command = await f.script("process.stdout.write('hello from task'); process.stderr.write(' and stderr');");
  const job = await f.manager.start({ ...f.input(command), name: 'Fixture build' });
  assert.equal(job.state, 'awaiting_approval');
  await until(() => f.state(job).state === 'completed');
  const result = f.output(job);
  assert.match(result.output, /hello from task/);
  assert.match(result.output, /and stderr/);
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputWithheld, false);
  assert.equal(f.context.children.length, 1);
  const objects = [f.state(job), ...f.manager.list({ workspaceId: f.context.workspace.id }), ...f.context.events, ...f.context.audits];
  for (const object of objects) {
    for (const property of ['command', 'cwd', 'output', 'stdout', 'stderr', 'pid', 'workspaceId', 'environment']) assert.equal(Object.hasOwn(object, property), false, property);
    const serialized = JSON.stringify(object);
    assert.equal(serialized.includes(command), false);
    assert.equal(serialized.includes(f.root), false);
    assert.equal(serialized.includes('hello from task'), false);
  }
});

test('nonzero subprocess exit reports failed without returning execution errors or paths', async t => {
  const f = await fixture(t, { confirm: async () => true });
  const command = await f.script("process.exitCode = 7;");
  const job = await f.manager.start(f.input(command));
  await until(() => f.state(job).state === 'failed');
  assert.equal(f.state(job).exitCode, 7);
  assert.equal(f.state(job).failureCode, 'COMMAND_EXIT');
});

test('timeout kills the owned real subprocess tree', async t => {
  const f = await fixture(t, { confirm: async () => true });
  const source = `
    const fs = require('node:fs');
    require('node:child_process').spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync('escaped.txt', 'unexpected'), 2000)"], { stdio: 'inherit' });
    fs.writeFileSync('started.txt', 'started');
    setTimeout(() => {}, 5000);
  `;
  const command = await f.script(source);
  const job = await f.manager.start({ ...f.input(command), timeoutMs: 1_000 });
  await until(() => fsSync.existsSync(path.join(f.root, 'started.txt')));
  await until(() => f.state(job).state === 'timed_out');
  await until(() => f.context.children[0].exitCode !== null || f.context.children[0].signalCode !== null);
  await delay(2_100);
  assert.equal(fsSync.existsSync(path.join(f.root, 'escaped.txt')), false);
  assert.equal(f.state(job).failureCode, 'TIMEOUT');
});

test('explicit cancellation kills a running real subprocess tree', async t => {
  const f = await fixture(t, { confirm: async () => true });
  const command = await f.script(`
    const fs = require('node:fs');
    require('node:child_process').spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync('escaped.txt', 'unexpected'), 2000)"], { stdio: 'inherit' });
    fs.writeFileSync('started.txt', 'started');
    setTimeout(() => {}, 5000);
  `);
  const job = await f.manager.start(f.input(command));
  await until(() => fsSync.existsSync(path.join(f.root, 'started.txt')));
  assert.equal(f.manager.cancel({ workspaceId: f.context.workspace.id, id: job.id }).state, 'stopping');
  await until(() => f.context.children[0].exitCode !== null || f.context.children[0].signalCode !== null);
  await delay(2_100);
  assert.equal(fsSync.existsSync(path.join(f.root, 'escaped.txt')), false);
  assert.equal(f.state(job).state, 'cancelled');
});

test('workspace, trust and terminal permission are rechecked after approval and cwd awaits', async t => {
  for (const change of ['workspace', 'trust', 'terminal']) {
    const pending = deferred();
    const f = await fixture(t, { confirm: () => pending.promise });
    const job = await f.manager.start(f.input('echo example'));
    await delay(25);
    if (change === 'workspace') f.context.workspace = { ...f.context.workspace, id: 'replacement-session' };
    if (change === 'trust') f.context.workspace.trusted = false;
    if (change === 'terminal') f.context.access.terminal = false;
    pending.resolve(true);
    await delay(60);
    assert.equal(f.context.children.length, 0, change);
    assert.equal(f.context.events.at(-1).state, 'cancelled', change);
    if (change === 'terminal') assert.equal(f.state(job).failureCode, 'ACCESS_REVOKED');
  }

  const waitingPath = deferred();
  let calls = 0;
  let f;
  f = await fixture(t, {
    confirm: async () => true,
    checkCwd: async (_, cwd) => { if (++calls > 1) await waitingPath.promise; return cwd; },
  });
  const job = await f.manager.start(f.input('echo example'));
  await until(() => calls === 2);
  f.context.access.terminal = false;
  waitingPath.resolve();
  await until(() => f.state(job).state === 'cancelled');
  assert.equal(f.context.children.length, 0);
});

test('revoking terminal access stops an already running subprocess', async t => {
  const f = await fixture(t, { confirm: async () => true });
  const command = await f.script("process.stdout.write('ready'); setInterval(() => {}, 1000);");
  const job = await f.manager.start(f.input(command));
  await until(() => f.output(job).output === 'ready');
  f.context.access.terminal = false;
  await until(() => f.state(job).state === 'cancelled');
  await until(() => f.context.children[0].exitCode !== null || f.context.children[0].signalCode !== null);
  assert.equal(f.state(job).failureCode, 'ACCESS_REVOKED');
});

test('cross workspace and cross manager task IDs cannot be read, cancelled or enumerated', async t => {
  const first = await fixture(t, { confirm: () => new Promise(() => {}) });
  const second = await fixture(t, { confirm: () => new Promise(() => {}) });
  const job = await first.manager.start(first.input('echo example'));
  const originalId = first.context.workspace.id;
  assert.throws(() => first.manager.get({ workspaceId: 'other-session', id: job.id }), { code: 'WORKSPACE_CHANGED' });
  assert.throws(() => first.manager.cancel({ workspaceId: 'other-session', id: job.id }), { code: 'WORKSPACE_CHANGED' });
  assert.throws(() => second.manager.get({ workspaceId: second.context.workspace.id, id: job.id }), { code: 'TASK_NOT_FOUND' });
  assert.throws(() => second.manager.cancel({ workspaceId: second.context.workspace.id, id: job.id }), { code: 'TASK_NOT_FOUND' });
  first.context.workspace.id = 'new-session';
  assert.deepEqual(first.manager.list({ workspaceId: first.context.workspace.id }), []);
  assert.throws(() => first.manager.get({ workspaceId: first.context.workspace.id, id: job.id }), { code: 'TASK_NOT_FOUND' });
  first.context.workspace.id = originalId;
});

test('credential output split across chunks is withheld only on explicit output reads', async t => {
  const f = await fixture(t, { confirm: async () => true });
  const command = await f.script("process.stdout.write('sk-'); setTimeout(() => process.stdout.write('A'.repeat(40)), 30);");
  const job = await f.manager.start(f.input(command));
  await until(() => f.state(job).state === 'completed');
  assert.equal(Object.hasOwn(f.state(job), 'output'), false);
  const result = f.output(job);
  assert.equal(result.outputWithheld, true);
  assert.equal(Object.hasOwn(result, 'output'), false);
  assert.equal(JSON.stringify(result).includes('sk-' + 'A'.repeat(40)), false);
  assert.throws(() => f.manager.get({ workspaceId: f.context.workspace.id, id: job.id, includeOutput: 'true' }), { code: 'INVALID_OUTPUT_OPTION' });
});

test('combined stdout and stderr have a 64000 byte total cap and stop runaway output', async t => {
  const f = await fixture(t, { confirm: async () => true });
  const command = await f.script("process.stdout.write('a'.repeat(40000)); process.stderr.write('b'.repeat(40000)); setInterval(() => {}, 1000);");
  const job = await f.manager.start(f.input(command));
  await until(() => f.state(job).state === 'failed');
  const result = f.output(job);
  assert.equal(result.failureCode, 'OUTPUT_LIMIT');
  assert.equal(result.outputBytes, MAX_OUTPUT_BYTES);
  assert.equal(Buffer.byteLength(result.output), MAX_OUTPUT_BYTES);
  assert.equal(result.outputTruncated, true);
  await until(() => f.context.children[0].exitCode !== null || f.context.children[0].signalCode !== null);
});

test('pending approvals count toward concurrency, concurrent starts cannot exceed three, and terminal history is bounded', async t => {
  const pending = await fixture(t, { confirm: () => new Promise(() => {}) });
  const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => pending.manager.start(pending.input('echo example'))));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 3);
  assert.equal(attempts.filter(item => item.status === 'rejected' && item.reason.code === 'TASK_LIMIT').length, 7);
  pending.manager.cancelAll();
  assert.equal(pending.manager.list({ workspaceId: pending.context.workspace.id }).every(job => job.state === 'cancelled'), true);

  const history = await fixture(t);
  for (let i = 0; i < 24; i++) {
    const job = await history.manager.start(history.input('echo example'));
    await until(() => history.state(job).state === 'rejected');
  }
  assert.equal(history.manager.list({ workspaceId: history.context.workspace.id }).length, 20);
});

test('spawn receives only whitelisted environment; callback errors cannot leak through task metadata', async t => {
  let spawnOptions;
  const f = await fixture(t, {
    confirm: async () => true,
    environment: { PATH: process.env.PATH || '', EXAMPLE_PRIVATE_VALUE: 'should not pass', NODE_OPTIONS: '--inspect', NODE_PATH: 'external', LC_ALL: 'C' },
    spawn: (_, __, options) => { spawnOptions = options; throw new Error('private runtime details'); },
  });
  const job = await f.manager.start(f.input('echo example'));
  await until(() => f.state(job).state === 'failed');
  assert.deepEqual(Object.keys(spawnOptions.env).sort(), ['LC_ALL', 'PATH']);
  assert.equal(JSON.stringify(f.state(job)).includes('private runtime'), false);
  assert.equal(Object.hasOwn(spawnOptions, 'pid'), false);
  assert.equal(spawnOptions.stdio[0], 'ignore');
  assert.deepEqual(safeTaskEnvironment({ PATH: 'example', API_KEY: 'excluded', TEMP: 'example', UNRELATED: 'excluded' }), { PATH: 'example', TEMP: 'example' });
});

test('only Windows child PATH drops exact duplicate entries and preserves first occurrence, quoting and order', () => {
  const source = { Path: 'alpha;"beta gamma";alpha;;delta;"beta gamma";;ALPHA', HOME: 'example', NODE_OPTIONS: '--inspect' };
  const before = { ...source };
  assert.deepEqual(safeTaskEnvironment(source, 'win32'), { Path: 'alpha;"beta gamma";;delta;ALPHA', HOME: 'example' });
  assert.deepEqual(safeTaskEnvironment(source, 'linux'), { Path: source.Path, HOME: 'example' });
  assert.deepEqual(source, before);
  const longPath = Array.from({ length: 2_000 }, (_, index) => `entry-${index}`).join(';');
  assert.equal(safeTaskEnvironment({ PATH: longPath }, 'win32').PATH, longPath);
});

test('invalid inputs never reach local approval or process spawning', async t => {
  const f = await fixture(t);
  for (const changes of [{ timeoutMs: 600_001 }, { timeoutMs: 0 }, { name: '\ninvalid' }, { command: '' }, { command: 'echo \0' }, { cwd: 'relative' }]) {
    await assert.rejects(f.manager.start({ ...f.input('echo example'), ...changes }));
  }
  assert.equal(f.context.children.length, 0);
  assert.equal(f.context.approvals.length, 0);
  assert.equal(f.manager.list({ workspaceId: f.context.workspace.id }).length, 0);
});

test('cancellation remains terminal even when the owned child closes later', async t => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  let kills = 0;
  const f = await fixture(t, { confirm: async () => true, spawn: () => child, kill: () => { kills++; } });
  const job = await f.manager.start(f.input('echo example'));
  await until(() => f.state(job).state === 'running');
  f.manager.cancel({ workspaceId: f.context.workspace.id, id: job.id });
  assert.equal(f.state(job).state, 'stopping');
  child.stdout.emit('data', Buffer.from('late output'));
  child.emit('close', 0, null);
  assert.equal(kills, 1);
  assert.equal(f.state(job).state, 'cancelled');
  assert.equal(f.output(job).output, '');
});

test('cancel and timeout keep all three process slots occupied until owned children close', async t => {
  const children = [];
  const f = await fixture(t, {
    confirm: async () => true,
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
    kill: () => {},
  });
  const jobs = await Promise.all(Array.from({ length: 3 }, (_, index) => f.manager.start({
    ...f.input('echo example'), timeoutMs: index === 0 ? 100 : 30_000,
  })));
  await until(() => children.length === 3);
  await until(() => f.state(jobs[0]).state === 'stopping');
  assert.equal(f.state(jobs[0]).failureCode, 'TIMEOUT');
  assert.equal(Object.hasOwn(f.state(jobs[0]), 'finishedAt'), false);
  f.manager.cancel({ workspaceId: f.context.workspace.id, id: jobs[1].id });
  f.manager.cancel({ workspaceId: f.context.workspace.id, id: jobs[2].id });
  assert.equal(jobs.every(job => f.state(job).state === 'stopping'), true);
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(f.manager.start(f.input('echo example')), { code: 'TASK_LIMIT' });
  }
  assert.equal(children.length, 3);
  children[0].emit('close', null, 'SIGTERM');
  assert.equal(f.state(jobs[0]).state, 'timed_out');
  const replacement = await f.manager.start(f.input('echo example'));
  assert.equal(replacement.state, 'awaiting_approval');
  await until(() => children.length === 4);
  await assert.rejects(f.manager.start(f.input('echo example')), { code: 'TASK_LIMIT' });
  children[1].emit('close', null, 'SIGTERM');
  children[2].emit('close', null, 'SIGTERM');
  assert.equal(f.state(jobs[1]).state, 'cancelled');
  assert.equal(f.state(jobs[2]).state, 'cancelled');
  f.manager.cancel({ workspaceId: f.context.workspace.id, id: replacement.id });
  children[3].emit('close', null, 'SIGTERM');
});

test('session clearing hides history immediately but preserves old live process slots until close', async t => {
  const children = [];
  const f = await fixture(t, {
    confirm: async () => true,
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
    kill: () => {},
  });
  const oldScope = f.context.workspace.id;
  const jobs = await Promise.all(Array.from({ length: 3 }, () => f.manager.start(f.input('echo example'))));
  await until(() => children.length === 3);
  f.manager.cancelAll({ clear: true });
  f.context.workspace.id = 'replacement-session';
  const notificationsAtReset = f.context.events.length;
  assert.deepEqual(f.manager.list({ workspaceId: f.context.workspace.id }), []);
  for (const job of jobs) {
    assert.throws(() => f.manager.get({ workspaceId: oldScope, id: job.id }), { code: 'WORKSPACE_CHANGED' });
    assert.throws(() => f.manager.get({ workspaceId: f.context.workspace.id, id: job.id, includeOutput: true }), { code: 'TASK_NOT_FOUND' });
  }
  // A second reset also cannot forget the three stopping OS children.
  f.manager.cancelAll({ clear: true });
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => f.manager.start(f.input('echo example'))));
  assert.equal(attempts.every(result => result.status === 'rejected' && result.reason.code === 'TASK_LIMIT'), true);
  assert.equal(children.length, 3);
  children[0].emit('close', null, 'SIGTERM');
  assert.equal(f.context.events.length, notificationsAtReset);
  const replacement = await f.manager.start(f.input('echo example'));
  await until(() => children.length === 4);
  assert.equal(f.state(replacement).state, 'running');
  await assert.rejects(f.manager.start(f.input('echo example')), { code: 'TASK_LIMIT' });
  children[1].emit('close', null, 'SIGTERM');
  children[2].emit('close', null, 'SIGTERM');
  assert.equal(f.manager.list({ workspaceId: f.context.workspace.id }).length, 1);
  assert.equal(f.context.events.slice(notificationsAtReset).every(event => event.id === replacement.id), true);
  f.manager.cancelAll();
  children[3].emit('close', null, 'SIGTERM');
});

test('get/list/cancel and explicit output reads all require current workspace read permission', async t => {
  const f = await fixture(t, { confirm: () => new Promise(() => {}) });
  const job = await f.manager.start(f.input('echo example'));
  f.context.access.read = false;
  for (const operation of [
    () => f.manager.get({ workspaceId: f.context.workspace.id, id: job.id }),
    () => f.manager.get({ workspaceId: f.context.workspace.id, id: job.id, includeOutput: true }),
    () => f.manager.list({ workspaceId: f.context.workspace.id }),
    () => f.manager.cancel({ workspaceId: f.context.workspace.id, id: job.id }),
  ]) assert.throws(operation, { code: 'ACCESS_DENIED' });
  f.context.access.read = true;
  f.context.access.terminal = false;
  await until(() => f.state(job).state === 'cancelled');
  assert.equal(f.output(job).output, '');
  assert.equal(f.manager.list({ workspaceId: f.context.workspace.id }).length, 1);
});
