'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const defaultSecurity = require('./security');

const MAX_OUTPUT_BYTES = 64_000;
const MAX_ACTIVE_TASKS = 3;
const MAX_HISTORY = 20;
const MAX_TIMEOUT_MS = 3_600_000;
const SCAN_WINDOW = 8_192;
const ACTIVE_STATES = new Set(['awaiting_approval', 'running', 'stopping']);
const ENV_ALLOWLIST = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'TERM',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
]);

function safeTaskEnvironment(source = process.env, platform = process.platform) {
  const allowed = Object.entries(source).filter(([key, value]) =>
    ENV_ALLOWLIST.has(key.toUpperCase()) && typeof value === 'string' && !value.includes('\0'));
  return Object.fromEntries(allowed.map(([key, value]) => {
    if (platform === 'win32' && key.toUpperCase() === 'PATH') {
      // Preserve the first exact spelling, quoted entries, empty entries and order.
      // Do not normalize paths or truncate PATH: both can change command lookup.
      return [key, [...new Set(value.split(';'))].join(';')];
    }
    return [key, value];
  }));
}

// Only a child created by this manager reaches this function. No API accepts a PID.
function killTaskTree(child) {
  if (!Number.isSafeInteger(child?.pid) || child.pid < 1) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const systemRoot = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
    if (!systemRoot || !path.win32.isAbsolute(systemRoot) || systemRoot.includes('\0')) {
      try { child.kill(); } catch {}
      return;
    }
    const executable = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
    try {
      const killer = childProcess.spawn(executable, ['/PID', String(child.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore', env: safeTaskEnvironment(),
      });
      killer.once('error', () => { try { child.kill(); } catch {} });
      killer.once('exit', code => { if (code !== 0) { try { child.kill(); } catch {} } });
    } catch { try { child.kill(); } catch {} }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

function createTaskManager({
  getWorkspace, getAccess, checkCwd, confirm, validateCommand = () => {},
  environment = () => process.env, audit = () => {}, onChange = () => {},
  spawn = childProcess.spawn, kill = killTaskTree, security = defaultSecurity,
  approvalTimeoutMs = 30_000, checkIntervalMs = 250, capability = 'terminal', getActiveTaskCount,
}) {
  if ([getWorkspace, getAccess, checkCwd, confirm, validateCommand, spawn, kill].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Task manager requires workspace, access, directory and approval callbacks.');
  }
  const { BridgeError, assertWorkspace, assertSafeContent } = security;
  if (!['terminal', 'tasks'].includes(capability)) throw new TypeError('Choose terminal or tasks access.');
  if (getActiveTaskCount !== undefined && typeof getActiveTaskCount !== 'function') throw new TypeError('Active-task counting requires a callback.');
  const tasks = new Map();
  // Session/history clearing must not release an OS process slot before close.
  const liveChildren = new Map();
  const host = { getWorkspace, getAccess };
  const approvalDuration = Number.isInteger(approvalTimeoutMs) && approvalTimeoutMs > 0 ? Math.min(approvalTimeoutMs, 30_000) : 30_000;
  const checkDuration = Number.isInteger(checkIntervalMs) && checkIntervalMs > 0 ? Math.min(checkIntervalMs, 250) : 250;
  let disposed = false;

  function fail(code, message) { throw new BridgeError(code, message); }
  function snapshot(workspaceId, capability = 'read') {
    if (disposed) fail('TASK_MANAGER_DISPOSED', 'The terminal task manager is closed.');
    if (typeof workspaceId !== 'string' || !workspaceId) fail('WORKSPACE_REQUIRED', 'Pass the workspaceId from workspace_overview.');
    return assertWorkspace(host, workspaceId, { capability });
  }
  function metadata(task) {
    return {
      id: task.id, name: task.name, state: task.state,
      createdAt: task.createdAt, updatedAt: task.updatedAt, timeoutMs: task.timeoutMs,
      outputBytes: task.outputBytes, outputTruncated: task.outputTruncated,
      totalOutputBytes: task.totalOutputBytes, outputStartByte: task.totalOutputBytes - task.outputBytes,
      ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
      ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      ...(task.failureCode ? { failureCode: task.failureCode } : {}),
    };
  }
  function notify(task) {
    if (tasks.get(task.id) !== task) return;
    // Audit/UI payloads deliberately exclude commands, paths, environment and output.
    try { audit({ operation: 'terminal_task', id: task.id, state: task.state }); } catch {}
    try { onChange(metadata(task)); } catch {}
  }
  function pruneHistory() {
    const history = [...tasks.values()].filter(task => !ACTIVE_STATES.has(task.state) && !task.child);
    while (history.length > MAX_HISTORY) {
      const old = history.shift();
      tasks.delete(old.id);
      old.output.length = 0;
      old.command = '';
      old.cwd = '';
      old.approval = undefined;
      old.beforeLaunch = undefined;
      old.scanTail = '';
    }
  }
  function clearTimers(task) {
    clearImmediate(task.approvalImmediate);
    clearTimeout(task.approvalTimer);
    clearTimeout(task.executionTimer);
    clearInterval(task.accessTimer);
  }
  function finish(task, state, failureCode) {
    if (!ACTIVE_STATES.has(task.state)) return false;
    clearTimers(task);
    task.state = state;
    task.updatedAt = Date.now();
    task.finishedAt = task.updatedAt;
    if (failureCode) task.failureCode = failureCode;
    notify(task);
    pruneHistory();
    return true;
  }
  function terminate(task, state, failureCode) {
    if (!ACTIVE_STATES.has(task.state) || task.state === 'stopping') return;
    if (!task.child) { finish(task, state, failureCode); return; }
    clearTimers(task);
    task.state = 'stopping';
    task.finalState = state;
    task.finalFailureCode = failureCode;
    task.failureCode = failureCode;
    task.updatedAt = Date.now();
    notify(task);
    try { kill(task.child); } catch { try { task.child.kill(); } catch {} }
  }
  function isPending(task) {
    return !disposed && tasks.get(task.id) === task && task.state === 'awaiting_approval';
  }
  function checkTaskAccess(task) {
    return snapshot(task.workspaceId, capability);
  }
  async function validatedCwd(workspace, cwd) {
    let canonical;
    try { canonical = await checkCwd(workspace, cwd, capability); }
    catch (error) {
      if (error instanceof BridgeError) throw error;
      fail('PATH_UNAVAILABLE', 'The workspace directory cannot be accessed.');
    }
    snapshot(workspace.id, capability);
    if (typeof canonical !== 'string' || !path.isAbsolute(canonical)) fail('INVALID_PATH', 'An absolute workspace directory is required.');
    return canonical;
  }
  function validateCommandText(command) {
    if (typeof command !== 'string' || !command.trim() || command.length > 8_192 || command.includes('\0')) {
      fail('INVALID_COMMAND', 'Provide a command of 1 to 8192 characters.');
    }
    assertSafeContent(command);
    validateCommand(command);
  }
  function activeCount() {
    // Stopping processes retain their slots until the owned child reports close.
    const pending = [...tasks.values()].filter(task => ACTIVE_STATES.has(task.state) && !task.child).length;
    return pending + liveChildren.size;
  }
  function assertSlotAvailable() {
    const count = getActiveTaskCount ? getActiveTaskCount() : activeCount();
    if (!Number.isSafeInteger(count) || count < 0 || count >= MAX_ACTIVE_TASKS) fail('TASK_LIMIT', 'At most three command tasks may run or await local approval.');
  }
  function find(workspaceId, id) {
    snapshot(workspaceId);
    const task = typeof id === 'string' ? tasks.get(id) : undefined;
    if (!task || task.workspaceId !== workspaceId) fail('TASK_NOT_FOUND', 'This task does not belong to the current workspace session.');
    return task;
  }

  function launch(task) {
    checkTaskAccess(task);
    if (!isPending(task)) return;
    validateCommandText(task.command);
    const source = typeof environment === 'function' ? environment() : environment;
    let child;
    try {
      child = spawn(task.command, [], {
        cwd: task.cwd, shell: true, windowsHide: true,
        env: safeTaskEnvironment(source || {}),
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(task, 'failed', 'COMMAND_FAILED');
      return;
    }
    task.child = child;
    liveChildren.set(child, task);
    clearTimeout(task.approvalTimer);
    task.state = 'running';
    task.startedAt = Date.now();
    task.updatedAt = task.startedAt;
    task.executionTimer = setTimeout(() => terminate(task, 'timed_out', 'TIMEOUT'), task.timeoutMs);
    task.executionTimer.unref?.();
    const withholdOutput = () => {
      task.outputWithheld = true;
      task.output.length = 0;
      task.outputBytes = 0;
      task.scanTail = '';
    };
    const collect = chunk => {
      if (task.state !== 'running') return;
      const buffer = Buffer.from(chunk);
      task.totalOutputBytes = Math.min(Number.MAX_SAFE_INTEGER, task.totalOutputBytes + buffer.length);
      task.outputTruncated ||= task.totalOutputBytes > MAX_OUTPUT_BYTES;
      if (task.outputWithheld) return;
      // Scan before eviction: a credential cannot become visible when its prefix
      // falls outside the rolling log. Keep only a small decoder/scanner window.
      try {
        for (let offset = 0; offset < buffer.length; offset += 4_096) {
          const text = task.decoder.decode(buffer.subarray(offset, offset + 4_096), { stream: true });
          const scan = task.scanTail + text;
          // A synthetic closing delimiter also detects a long credential before
          // its final boundary/quote arrives in a later chunk.
          assertSafeContent(scan + '" ');
          if (/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b["']?\s*[:=]\s{4,}$/i.test(scan)) {
            throw new Error('Ambiguous credential assignment.');
          }
          task.scanTail = scan.slice(-SCAN_WINDOW);
        }
      } catch { withholdOutput(); return; }
      if (buffer.length >= MAX_OUTPUT_BYTES) {
        task.output = [Buffer.from(buffer.subarray(buffer.length - MAX_OUTPUT_BYTES))];
        task.outputBytes = MAX_OUTPUT_BYTES;
        return;
      }
      task.output.push(buffer);
      task.outputBytes += buffer.length;
      while (task.outputBytes > MAX_OUTPUT_BYTES) {
        const excess = task.outputBytes - MAX_OUTPUT_BYTES;
        const first = task.output[0];
        if (first.length <= excess) { task.output.shift(); task.outputBytes -= first.length; }
        else { task.output[0] = Buffer.from(first.subarray(excess)); task.outputBytes -= excess; }
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', () => {
      if (task.state === 'running') finish(task, 'failed', 'COMMAND_FAILED');
    });
    child.once('close', (exitCode, signal) => {
      if (!task.outputWithheld) {
        try { assertSafeContent(task.scanTail + task.decoder.decode()); }
        catch { withholdOutput(); }
      }
      liveChildren.delete(child);
      task.child = undefined;
      if (task.state === 'running' || task.state === 'stopping') {
        task.exitCode = Number.isInteger(exitCode) ? exitCode : null;
        task.signal = typeof signal === 'string' && /^[A-Z0-9]{1,20}$/.test(signal) ? signal : null;
        if (task.state === 'stopping') finish(task, task.finalState, task.finalFailureCode);
        else finish(task, exitCode === 0 ? 'completed' : 'failed', exitCode === 0 ? undefined : 'COMMAND_EXIT');
      }
      pruneHistory();
    });
    // Recheck immediately after spawn, as well as throughout execution.
    try { checkTaskAccess(task); }
    catch { terminate(task, 'cancelled', 'ACCESS_REVOKED'); }
    if (task.state === 'running') notify(task);
  }

  async function approve(task) {
    if (!isPending(task)) return;
    try {
      checkTaskAccess(task);
      const approved = await confirm({ command: task.command, cwd: task.cwd, workspaceId: task.workspaceId,
        ...(task.approval ? { approval: task.approval } : {}) });
      if (!isPending(task)) return;
      const workspace = checkTaskAccess(task);
      if (approved !== true) { finish(task, 'rejected', 'APPROVAL_DENIED'); return; }
      const canonical = await validatedCwd(workspace, task.cwd);
      if (!isPending(task)) return;
      checkTaskAccess(task);
      if (canonical !== task.cwd) { finish(task, 'cancelled', 'PATH_CHANGED'); return; }
      // Internal project-task adapters bind approval to the exact manifest and
      // recheck it after the local dialog. MCP schemas never accept callbacks.
      if (task.beforeLaunch) await task.beforeLaunch();
      if (!isPending(task)) return;
      checkTaskAccess(task);
      launch(task);
    } catch (error) {
      if (!isPending(task)) return;
      const revoked = ['WORKSPACE_CHANGED', 'UNTRUSTED_WORKSPACE', 'ACCESS_DENIED', 'NO_WORKSPACE', 'TASK_MANAGER_DISPOSED'].includes(error?.code);
      finish(task, revoked ? 'cancelled' : 'rejected', revoked ? 'ACCESS_REVOKED' : 'APPROVAL_FAILED');
    }
  }

  async function start({ workspaceId, command, cwd, name = 'Terminal task', timeoutMs = 30_000, approval, beforeLaunch } = {}) {
    const workspace = snapshot(workspaceId, capability);
    validateCommandText(command);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) fail('INVALID_PATH', 'An absolute workspace directory is required.');
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) fail('INVALID_TASK_NAME', 'Use a short task name of 1 to 80 characters without control characters.');
    assertSafeContent(name);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) fail('INVALID_TIMEOUT', 'Task timeout must be between 1 and 3600000 milliseconds.');
    if (beforeLaunch !== undefined && typeof beforeLaunch !== 'function') fail('INVALID_TASK', 'An internal validation callback is required.');
    assertSlotAvailable();
    const absolutePath = await validatedCwd(workspace, cwd);
    snapshot(workspace.id, capability);
    assertSlotAvailable();
    const timestamp = Date.now();
    const task = {
      id: crypto.randomBytes(16).toString('hex'), workspaceId, command, cwd: absolutePath,
      name: name.trim(), timeoutMs, state: 'awaiting_approval', createdAt: timestamp, updatedAt: timestamp,
      output: [], outputBytes: 0, totalOutputBytes: 0, outputTruncated: false,
      decoder: new TextDecoder('utf-8', { fatal: true }), scanTail: '', outputWithheld: false,
      approval, beforeLaunch,
    };
    tasks.set(task.id, task);
    task.approvalTimer = setTimeout(() => finish(task, 'rejected', 'APPROVAL_EXPIRED'), approvalDuration);
    task.approvalTimer.unref?.();
    task.accessTimer = setInterval(() => {
      try { checkTaskAccess(task); }
      catch { terminate(task, 'cancelled', 'ACCESS_REVOKED'); }
    }, checkDuration);
    task.accessTimer.unref?.();
    // Returning the job never waits for a local dialog or a command to finish.
    task.approvalImmediate = setImmediate(() => { void approve(task); });
    notify(task);
    return metadata(task);
  }
  function get({ workspaceId, id, includeOutput = false } = {}) {
    const task = find(workspaceId, id);
    if (typeof includeOutput !== 'boolean') fail('INVALID_OUTPUT_OPTION', 'includeOutput must be a boolean.');
    const result = metadata(task);
    if (!includeOutput) return result;
    if (task.outputWithheld) return { ...result, outputWithheld: true, outputNotice: 'Output was withheld because it may contain credentials or binary data.' };
    let output;
    try {
      let retained = Buffer.concat(task.output);
      // Rolling eviction can split the first UTF-8 code point. Exclude only its
      // continuation bytes; invalid data elsewhere remains fail closed.
      let skipped = 0;
      if (task.outputTruncated) while (skipped < retained.length && (retained[skipped] & 0xc0) === 0x80) skipped++;
      retained = retained.subarray(skipped);
      output = new TextDecoder('utf-8', { fatal: true }).decode(retained);
      assertSafeContent(output);
      result.outputStartByte += skipped;
    }
    catch {
      return { ...result, outputWithheld: true, outputNotice: 'Output was withheld because it may contain credentials or binary data.' };
    }
    return { ...result, output, outputWithheld: false,
      ...(task.outputTruncated ? { outputNotice: 'Only the most recent output window is available; earlier output was discarded.' } : {}) };
  }
  function list({ workspaceId } = {}) {
    snapshot(workspaceId);
    return [...tasks.values()].filter(task => task.workspaceId === workspaceId).reverse().map(metadata);
  }
  function cancel({ workspaceId, id } = {}) {
    const task = find(workspaceId, id);
    terminate(task, 'cancelled', 'CANCELLED');
    return metadata(task);
  }
  function cancelAll({ clear = false } = {}) {
    for (const task of tasks.values()) terminate(task, 'cancelled', 'CANCELLED');
    if (clear) {
      for (const task of tasks.values()) { task.output.length = 0; task.command = ''; task.cwd = ''; task.approval = undefined; task.beforeLaunch = undefined; task.scanTail = ''; }
      tasks.clear();
    }
  }
  function dispose() {
    if (disposed) return;
    cancelAll({ clear: true });
    disposed = true;
  }

  return { start, get, list, cancel, cancelAll, dispose, activeCount };
}

module.exports = { createTaskManager, safeTaskEnvironment, MAX_OUTPUT_BYTES, MAX_ACTIVE_TASKS, MAX_HISTORY, MAX_TIMEOUT_MS };
