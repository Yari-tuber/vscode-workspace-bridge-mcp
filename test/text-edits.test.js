'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { applyTextEdits, replaceUniqueText } = require('../src/text-edits');
const { invokeTool } = require('../src/tools');
const { hashText } = require('../src/security');
const point = (line, character) => ({ line, character });
const edit = (line, start, end, text) => ({ range: { start: point(line, start), end: point(line, end) }, text });
const value = result => JSON.parse(result.content[0].text);

test('range edits use one original snapshot and preserve untouched CRLF and non-BMP characters', () => {
  const original = 'const name = "a😀b";\r\nconst answer = 42;\r\n';
  const proposed = applyTextEdits(original, [edit(1, 15, 17, '43'), edit(0, 17, 18, 'B')]);
  assert.equal(proposed, 'const name = "a😀B";\r\nconst answer = 43;\r\n');
  assert.equal(applyTextEdits('a😀b', [edit(0, 3, 4, 'B')]), 'a😀B');
  assert.throws(() => applyTextEdits('a😀b', [edit(0, 2, 3, 'broken')]), { code: 'INVALID_RANGE' });
  assert.equal(applyTextEdits('a\rb\nc', [edit(1, 0, 1, 'B')]), 'a\rB\nc');
});

test('overlap, duplicate insertion, reversed and out-of-range positions are refused', () => {
  assert.throws(() => applyTextEdits('abcdef', [edit(0, 1, 4, 'x'), edit(0, 3, 5, 'y')]), { code: 'OVERLAPPING_EDITS' });
  assert.throws(() => applyTextEdits('abcdef', [edit(0, 1, 1, 'x'), edit(0, 1, 1, 'y')]), { code: 'OVERLAPPING_EDITS' });
  for (const change of [edit(0, 4, 1, ''), edit(0, 0, 7, ''), edit(1, 0, 0, ''), edit(0, -1, 2, '')]) assert.throws(() => applyTextEdits('abcdef', [change]), { code: 'INVALID_RANGE' });
  assert.equal(applyTextEdits('abcdef', [edit(0, 1, 3, 'X'), edit(0, 3, 5, 'Y')]), 'aXYf');
  assert.equal(applyTextEdits('a\r\n', [edit(1, 0, 0, 'last')]), 'a\r\nlast');
});

test('unique replacement rejects absent or overlapping duplicate matches and blocks newly assembled credentials', () => {
  assert.equal(replaceUniqueText('const answer = 42;', '42', '43'), 'const answer = 43;');
  assert.throws(() => replaceUniqueText('aaa', 'aa', 'b'), { code: 'AMBIGUOUS_MATCH' });
  assert.throws(() => replaceUniqueText('public', 'missing', 'x'), { code: 'MATCH_NOT_FOUND' });
  assert.throws(() => replaceUniqueText('public', '', 'x'), { code: 'INVALID_MATCH' });
  assert.throws(() => replaceUniqueText('a😀b', '\ud83d', 'x'), { code: 'INVALID_TEXT' });
  assert.throws(() => replaceUniqueText('public', 'public', '\udc00'), { code: 'INVALID_TEXT' });
  const fabricatedPrefix = 'gh' + 'p_';
  assert.throws(() => replaceUniqueText(fabricatedPrefix + 'short', 'short', 'a1'.repeat(20)), { code: 'SENSITIVE_CONTENT' });
  assert.throws(() => applyTextEdits('x', [edit(0, 0, 1, '界'.repeat(190000))]), { code: 'FILE_TOO_LARGE' });
});

async function fixture(t, initial = 'const answer = 42;\r\n') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-patch-')));
  const disk = path.join(root, 'app.js'); await fs.writeFile(disk, initial);
  const access = { read: true, edit: false, terminal: false };
  const workspace = { id: 'patch-session', trusted: true, roots: [{ name: 'demo', path: root }] };
  const previews = []; const mutations = [];
  const host = { getWorkspace: () => workspace, getAccess: () => access,
    readDocument: async ({ path: target }) => ({ text: await fs.readFile(target, 'utf8'), version: 1, isDirty: false }),
    previewDiff: async args => { previews.push(args); return { opened: true }; },
    applyEdit: async args => { mutations.push(args); await fs.writeFile(args.path, args.text); return { applied: true, saved: true }; }
  };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { host, access, workspace, disk, previews, mutations, args: { workspaceId: workspace.id, path: 'app.js', expectedHash: hashText(initial) } };
}

test('patch tools require local edit access; default preview opens a diff without writing or leaking full text', async t => {
  const { host, access, disk, args, previews, mutations } = await fixture(t);
  const request = { ...args, edits: [edit(0, 15, 17, '43')] };
  assert.equal(value(await invokeTool(host, 'apply_text_edits', request)).error.code, 'ACCESS_DENIED');
  access.edit = true;
  const preview = value(await invokeTool(host, 'apply_text_edits', request));
  assert.equal(preview.previewed, true); assert.equal(preview.applied, false);
  assert.equal(previews.length, 1); assert.equal(mutations.length, 0);
  assert.equal(await fs.readFile(disk, 'utf8'), 'const answer = 42;\r\n');
  assert.equal(JSON.stringify(preview).includes('const answer'), false);
  const applied = value(await invokeTool(host, 'apply_text_edits', { ...request, previewOnly: false }));
  assert.equal(applied.applied, true); assert.equal(applied.hash, hashText(await fs.readFile(disk, 'utf8')));
  assert.equal(value(await invokeTool(host, 'apply_text_edits', { ...request, previewOnly: false })).error.code, 'EDIT_CONFLICT');
});

test('literal replacement uses the same conflict-safe host mutation path and denies stale workspace identities', async t => {
  const { host, access, workspace, disk, args } = await fixture(t);
  access.edit = true;
  const preview = value(await invokeTool(host, 'replace_text', { ...args, oldText: '42', newText: '100' }));
  assert.equal(preview.previewed, true);
  assert.equal(await fs.readFile(disk, 'utf8'), 'const answer = 42;\r\n');
  const result = value(await invokeTool(host, 'replace_text', { ...args, oldText: '42', newText: '100', previewOnly: false }));
  assert.equal(result.applied, true); assert.equal(await fs.readFile(disk, 'utf8'), 'const answer = 100;\r\n');
  workspace.id = 'different-session';
  assert.equal(value(await invokeTool(host, 'replace_text', { ...args, oldText: '100', newText: '200', previewOnly: false })).error.code, 'WORKSPACE_CHANGED');
});
