'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { startServer } = require('../src/server');
const { invokeTool } = require('../src/tools');
const { hashText } = require('../src/security');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-bridge-test-')));
  await fs.writeFile(path.join(root, 'hello.js'), 'const answer = 42;\n');
  const access = { read: true, edit: false, terminal: false };
  const workspace = { id: 'test-session', name: 'Synthetic test', trusted: true, roots: [{ name: 'fixture', path: root }] };
  const host = { getWorkspace: () => workspace, getAccess: () => access,
    readDocument: async ({ path: file }) => ({ text: await fs.readFile(file, 'utf8'), version: 1, isDirty: false }),
    applyEdit: async ({ path: file, text }) => { await fs.writeFile(file, text); return { applied: true, saved: true, version: 2 }; },
    getDiagnostics: async () => [], getSymbols: async () => [], getDefinition: async () => [], getReferences: async () => [],
    previewDiff: async () => ({ opened: true }), executeTerminal: async () => { throw new Error('Not approved'); }
  };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, host, workspace, access };
}
const value = result => JSON.parse(result.content[0].text);

test('official SDK client initializes, browses, reads, and obtains a review prompt', async t => {
  const { host, root } = await fixture(t);
  const token = crypto.randomBytes(32).toString('hex');
  const events = [];
  const server = await startServer({ host, token, port: 0, audit: event => events.push(event) });
  t.after(() => server.close());
  const client = new Client({ name: 'integration-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport); t.after(() => client.close());
  const tools = await client.listTools(); assert.equal(tools.tools.length, 41);
  const overview = value(await client.callTool({ name: 'workspace_overview', arguments: {} }));
  assert.equal(overview.workspaceId, 'test-session'); assert.equal(JSON.stringify(overview).includes(root), false);
  const read = value(await client.callTool({ name: 'read_file', arguments: { workspaceId: overview.workspaceId, path: 'hello.js' } }));
  assert.match(read.content, /answer = 42/); assert.equal(read.hash, hashText('const answer = 42;\n'));
  assert.equal((await client.listPrompts()).prompts[0].name, 'review_workspace');
  assert.match((await client.getPrompt({ name: 'review_workspace' })).messages[0].content.text, /untrusted/);
  assert.ok(events.length >= 2); assert.equal(JSON.stringify(events).includes('answer'), false); assert.equal(JSON.stringify(events).includes(token), false);
});

test('HTTP boundary rejects missing/wrong credentials, foreign hosts/origins, query tokens and invalid bodies without crashing', async t => {
  const { host } = await fixture(t); const token = crypto.randomBytes(32).toString('hex');
  const server = await startServer({ host, token, port: 0 }); t.after(() => server.close());
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(server.url, { method: 'POST', headers: { ...auth, Authorization: 'Bearer invalid' }, body: '{}' })).status, 401);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.port, path: '/mcp', method: 'POST', headers: { ...auth, Host: 'evil.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(server.url, { method: 'POST', headers: { ...auth, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(server.url + '?token=placeholder', { method: 'POST', headers: auth, body: '{}' })).status, 404);
  for (const body of ['null', '[]', '"text"', '{}', '{']) {
    assert.equal((await fetch(server.url, { method: 'POST', headers: auth, body })).status, 400);
  }
  const health = await fetch(server.url.replace('/mcp', '/health'), { headers: auth });
  assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: 'ready', version: require('../package.json').version });
  assert.equal((await fetch(server.url, { headers: auth })).status, 405);
  assert.equal((await fetch(server.url, { method: 'POST', headers: auth, body: JSON.stringify({ data: 'x'.repeat(512 * 1024) }) })).status, 413);
});

test('safe read/edit lifecycle preserves conflicts, permissions and workspace identity', async t => {
  const { host, root, access, workspace } = await fixture(t);
  const args = { workspaceId: workspace.id, path: 'hello.js' };
  const initial = value(await invokeTool(host, 'read_file', args));
  const edit = { ...args, text: 'const answer = 43;\n', expectedHash: initial.hash };
  assert.equal(value(await invokeTool(host, 'write_file', edit)).error.code, 'ACCESS_DENIED');
  access.edit = true;
  await fs.writeFile(path.join(root, 'hello.js'), 'changed outside bridge');
  assert.equal(value(await invokeTool(host, 'write_file', edit)).error.code, 'EDIT_CONFLICT');
  const refreshed = value(await invokeTool(host, 'read_file', args));
  assert.equal((await invokeTool(host, 'write_file', { ...edit, expectedHash: refreshed.hash })).isError, false);
  assert.equal(await fs.readFile(path.join(root, 'hello.js'), 'utf8'), edit.text);
  assert.equal((await invokeTool(host, 'write_file', { ...args, path: 'new.js', text: 'export const created = true;', expectedHash: 'new' })).isError, false);
  assert.equal(value(await invokeTool(host, 'write_file', { ...args, path: 'new.js', text: 'overwrite', expectedHash: 'new' })).error.code, 'FILE_EXISTS');
  assert.equal(value(await invokeTool(host, 'read_file', { ...args, path: '../outside' })).error.code, 'OUTSIDE_WORKSPACE');
  assert.equal(value(await invokeTool(host, 'read_file', { ...args, path: '.env' })).error.code, 'SENSITIVE_PATH');
  assert.equal(value(await invokeTool(host, 'run_terminal', { workspaceId: workspace.id, command: 'echo ok' })).error.code, 'ACCESS_DENIED');
  workspace.id = 'new-session';
  assert.equal(value(await invokeTool(host, 'write_file', edit)).error.code, 'WORKSPACE_CHANGED');
});

test('search excludes ignored files and credential-like content; errors and audits contain no supplied command', async t => {
  const { host, root, workspace, access } = await fixture(t);
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(root, 'ignored.txt'), 'answer hidden');
  await fs.writeFile(path.join(root, 'config.txt'), ['api_key = "', 'ghp_', 'a'.repeat(36), '"'].join(''));
  const listing = value(await invokeTool(host, 'list_files', { workspaceId: workspace.id }));
  assert.equal(listing.files.includes('ignored.txt'), false);
  const search = value(await invokeTool(host, 'search_text', { workspaceId: workspace.id, query: 'answer' }));
  assert.deepEqual(search.matches.map(m => m.path), ['hello.js']);
  assert.equal(value(await invokeTool(host, 'read_file', { workspaceId: workspace.id, path: 'config.txt' })).error.code, 'SENSITIVE_CONTENT');
  const events = []; access.terminal = true;
  const failed = await invokeTool(host, 'run_terminal', { workspaceId: workspace.id, command: 'sensitive user supplied command' }, { audit: e => events.push(e) });
  assert.equal(failed.isError, true); assert.equal(JSON.stringify(events).includes('sensitive'), false);
});
