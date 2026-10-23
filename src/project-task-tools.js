'use strict';

const { z } = require('zod');
const scope = { workspaceId: z.string().min(1).max(128), root: z.number().int().min(0).max(63).default(0) };

const definitions = [
  { name: 'list_project_tasks', description: 'List safe npm script names from the selected root package.json, with a manifest hash. Script command text is excluded. Read access is sufficient; this never executes code.',
    schema: z.object(scope).strict(), run: async (host, _workspace, args) => host.listProjectTasks(args) },
  { name: 'run_project_task', capability: 'tasks', description: 'Run one listed npm script with the exact manifestHash and separate project-task permission. A local approval policy is required; returns awaiting_approval immediately. npm lifecycle hooks may run. Scripts have full user privileges, not a sandbox. Poll get_project_task; default timeout is 2 minutes, maximum 60 minutes.',
    schema: z.object({ ...scope, taskName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), timeoutMs: z.number().int().min(1000).max(3_600_000).default(120_000) }).strict(),
    run: async (host, _workspace, args) => host.runProjectTask(args) },
  { name: 'get_project_task', description: 'Inspect an owned project task and a conservative TAP test summary if supported. Unknown reporters remain unknown; exit zero alone does not mean tests passed. Raw credential-filtered rolling output is excluded unless includeOutput=true. Earlier output may have been discarded.',
    schema: z.object({ workspaceId: scope.workspaceId, id: z.string().regex(/^[a-f0-9]{32}$/), includeOutput: z.boolean().default(false) }).strict(),
    run: async (host, _workspace, args) => host.getProjectTask(args) },
];

module.exports = { definitions };
