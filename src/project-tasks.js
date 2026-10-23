'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const defaultSecurity = require('./security');

const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_TASKS = 128;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;

// TAP is an optional, conservative interpretation of the retained log. npm can
// run arbitrary reporters; unknown output must never become a "tests passed".
function summarizeTests(result, security = defaultSecurity) {
  const unknown = reason => ({ format: 'unknown', status: 'unknown', reason });
  if (result.outputWithheld || typeof result.output !== 'string') return unknown('Output is unavailable or was withheld.');
  if (['awaiting_approval', 'running', 'stopping'].includes(result.state)) return unknown('The task has not finished.');
  if (result.state !== 'completed' && result.state !== 'failed') return unknown('The task did not finish normally.');
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...result.output.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm'))];
    if (matches.length !== 1) return unknown('No unambiguous TAP summary was found in the retained output.');
    counts[key] = Number(matches[0][1]);
    if (!Number.isSafeInteger(counts[key]) || counts[key] > 1_000_000) return unknown('The TAP summary is outside supported limits.');
  }
  if (counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo) {
    return unknown('The TAP summary contains inconsistent counts.');
  }
  if (!counts.tests) return unknown('The reporter did not report any tests.');
  const names = [...result.output.matchAll(/^ {0,32}not ok \d+ - (.{1,300})\r?$/gm)].slice(0, 20).map(match => match[1].replace(/[\x00-\x1f\x7f]/g, '').trim());
  try { for (const name of names) security.assertSafeContent(name); }
  catch { return unknown('Failure names were withheld.'); }
  const passed = result.state === 'completed' && result.exitCode === 0 && counts.fail === 0 && counts.cancelled === 0;
  return { format: 'tap', status: passed ? 'passed' : 'failed', counts, failedNames: names,
    failedNamesMayBeIncomplete: Boolean(result.outputTruncated || names.length < counts.fail),
    source: 'Program-reported summary from retained output; not independent proof of test coverage.' };
}

function createProjectTasks({ getWorkspace, getAccess, startTask, getTask, security = defaultSecurity }) {
  if ([getWorkspace, getAccess, startTask, getTask].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Project tasks require workspace, access and task-manager callbacks.');
  }
  const { BridgeError, assertWorkspace, resolvePath, hashText, assertSafeContent } = security;
  const host = { getWorkspace, getAccess };
  function snapshot(workspaceId, capability = 'read') {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new BridgeError('WORKSPACE_REQUIRED', 'Pass workspaceId from workspace_overview.');
    return assertWorkspace(host, workspaceId, { capability });
  }
  async function manifest(workspaceId, root, capability) {
    const workspace = snapshot(workspaceId, capability);
    if (!Number.isInteger(root) || root < 0 || root >= workspace.roots.length) throw new BridgeError('INVALID_ROOT', 'Choose a workspace root index.');
    const directory = await resolvePath(workspace, '', { root, directory: true });
    const absolute = await resolvePath(workspace, 'package.json', { root });
    snapshot(workspaceId, capability);
    let text;
    try {
      const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_MANIFEST_BYTES) throw new BridgeError('INVALID_MANIFEST', 'package.json must be a regular file of at most 512 KiB.');
        const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_MANIFEST_BYTES) throw new BridgeError('INVALID_MANIFEST', 'package.json exceeds 512 KiB.');
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('INVALID_MANIFEST', 'package.json could not be read as UTF-8.');
    }
    snapshot(workspaceId, capability);
    if (await resolvePath(workspace, 'package.json', { root }) !== absolute || await resolvePath(workspace, '', { root, directory: true }) !== directory) {
      throw new BridgeError('PATH_CHANGED', 'The project directory changed.');
    }
    let json;
    try { json = JSON.parse(text); }
    catch { throw new BridgeError('INVALID_MANIFEST', 'package.json is not valid JSON.'); }
    const scripts = json && typeof json === 'object' && json.scripts && typeof json.scripts === 'object' && !Array.isArray(json.scripts) ? json.scripts : {};
    const entries = Object.entries(scripts).filter(([name, command]) => SCRIPT_NAME.test(name) && typeof command === 'string' && command.trim() && command.length <= 8_192)
      .filter(([name]) => { try { assertSafeContent(name); return true; } catch { return false; } });
    return { directory, scripts: new Map(entries), rawScripts: scripts, hash: hashText(text), availableCount: entries.length };
  }
  async function list({ workspaceId, root = 0 } = {}) {
    const current = await manifest(workspaceId, root, 'read');
    snapshot(workspaceId);
    return { root, manifestHash: current.hash, tasks: [...current.scripts.keys()].sort().slice(0, MAX_TASKS).map(name => ({ name })),
      truncated: current.availableCount > MAX_TASKS,
      notice: 'Names only. Execution requires separate local project-task permission and a local approval policy. npm lifecycle scripts may also run.' };
  }
  async function run({ workspaceId, root = 0, taskName, manifestHash, timeoutMs = 120_000 } = {}) {
    snapshot(workspaceId, 'tasks');
    if (typeof taskName !== 'string' || !SCRIPT_NAME.test(taskName)) throw new BridgeError('INVALID_TASK_NAME', 'Use a listed project task name.');
    if (typeof manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifestHash)) throw new BridgeError('MANIFEST_REQUIRED', 'Pass the manifestHash from list_project_tasks.');
    const current = await manifest(workspaceId, root, 'tasks');
    if (current.hash !== manifestHash) throw new BridgeError('MANIFEST_CHANGED', 'package.json changed. List the project tasks again.');
    const script = current.scripts.get(taskName);
    if (!script) throw new BridgeError('PROJECT_TASK_NOT_FOUND', 'The task is not available in this root package.json.');
    assertSafeContent(script);
    const lifecycleScripts = [];
    for (const name of ['pre' + taskName, 'post' + taskName]) {
      if (!Object.hasOwn(current.rawScripts, name)) continue;
      const hook = current.rawScripts[name];
      if (typeof hook !== 'string' || hook.length > 8_192) throw new BridgeError('INVALID_PROJECT_TASK', 'A lifecycle hook is not supported. Review the package scripts locally.');
      assertSafeContent(hook);
      if (hook.trim()) lifecycleScripts.push({ name, script: hook });
    }
    // No caller-controlled arguments, shell syntax or path are interpolated.
    // npm's own lifecycle hooks remain arbitrary code and are disclosed locally.
    const command = `npm run -- ${taskName}`;
    return startTask({ workspaceId, cwd: current.directory, command, name: taskName, timeoutMs,
      approval: { kind: 'project_task', taskName, manifestHash, script,
        lifecycleScripts },
      beforeLaunch: async () => {
        const fresh = await manifest(workspaceId, root, 'tasks');
        if (fresh.hash !== manifestHash || fresh.directory !== current.directory) throw new BridgeError('MANIFEST_CHANGED', 'The project task changed while awaiting approval. List it again.');
      } });
  }
  function get({ workspaceId, id, includeOutput = false } = {}) {
    snapshot(workspaceId);
    if (typeof includeOutput !== 'boolean') throw new BridgeError('INVALID_OUTPUT_OPTION', 'includeOutput must be a boolean.');
    const result = getTask({ workspaceId, id, includeOutput: true });
    const summary = summarizeTests(result, security);
    if (includeOutput) return { ...result, testSummary: summary };
    const { output, outputNotice, ...metadata } = result;
    return { ...metadata, testSummary: summary };
  }
  return { list, run, get };
}

module.exports = { createProjectTasks, summarizeTests, MAX_MANIFEST_BYTES, MAX_TASKS };
