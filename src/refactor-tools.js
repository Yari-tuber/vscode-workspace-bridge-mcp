'use strict';

const { z } = require('zod');
const { resolvePath } = require('./security');

const scope = { workspaceId: z.string().min(1).max(128), root: z.number().int().min(0).max(63).default(0) };
const file = { ...scope, path: z.string().min(1).max(1000), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) };
const position = { ...file, line: z.number().int().min(0).max(1000000), character: z.number().int().min(0).max(100000) };
const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const atFile = method => async (host, workspace, args) => host[method]({ ...args, path: await resolvePath(workspace, args.path, { root: args.root }) });

const definitions = [
  { name: 'prepare_rename', capability: 'refactor', description: 'Prepare a semantic symbol rename using the installed language service. Opens every affected safe text file in a local diff and returns a short-lived refactorId plus per-file hashes. Positions are 0-based UTF-16. Changes are not applied until apply_refactor is locally approved. File operations, outside paths, secrets and oversized edits are rejected.',
    schema: z.object({ ...position, newName: z.string().trim().min(1).max(200) }).strict(), run: atFile('prepareRename') },
  { name: 'format_document', capability: 'refactor', description: 'Prepare document formatting with the installed formatter, opening a diff without applying or saving. Returns a short-lived refactorId for apply_refactor. Requires the current hash from read_file and local refactor access.',
    schema: z.object({ ...file, tabSize: z.number().int().min(1).max(16).default(2), insertSpaces: z.boolean().default(true) }).strict(), run: atFile('formatDocument') },
  { name: 'get_code_actions', capability: 'refactor', description: 'List bounded edit-only quick fixes and refactorings at a 0-based UTF-16 position using the installed language service. Command-bearing, resource-changing and unsafe actions are excluded. Returns short-lived actionId values; prepare_code_action previews a selection. No arbitrary editor command is executed.',
    schema: z.object(position).strict(), run: atFile('getCodeActions') },
  { name: 'prepare_code_action', capability: 'refactor', description: 'Open all file diffs for a safe actionId from get_code_actions. Rechecks document versions, hashes, disk changes and session permission, then returns a short-lived refactorId. Does not apply or save.',
    schema: z.object({ workspaceId: scope.workspaceId, actionId: identifier }).strict(), run: (host, _workspace, args) => host.prepareCodeAction(args) },
  { name: 'apply_refactor', capability: 'refactor', description: 'Apply an already previewed refactorId after local per-operation approval. Rechecks all affected file versions, buffer and disk hashes under ordered locks, and submits one text-only WorkspaceEdit. Leaves all changes in editor buffers for review; never auto-saves pre-existing unsaved work. Manual disk saves are not an atomic transaction.',
    schema: z.object({ workspaceId: scope.workspaceId, refactorId: identifier }).strict(), run: (host, _workspace, args) => host.applyRefactor(args) },
];

module.exports = { definitions };
