'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-bridge-integration-'));
  const profile = path.join(fixture, 'profile');
  const workspace = path.join(fixture, 'workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'hello.js'), 'const answer = 42;\nconsole.log(answer);\n');
  try {
    await runTests({
      ...(process.env.VSCODE_TEST_VERSION ? { version: process.env.VSCODE_TEST_VERSION } : {}),
      ...(process.env.VSCODE_EXECUTABLE ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE } : {}),
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'integration-suite.js'),
      extensionTestsEnv: { WORKSPACE_BRIDGE_TEST_REPORT: path.join(root, 'artifacts', 'integration-summary.json') },
      launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(fixture, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry', '--disable-gpu', '--no-sandbox']
    });
  } finally {
    const boundary = path.resolve(os.tmpdir()) + path.sep;
    if (!path.resolve(fixture).startsWith(boundary) || !path.basename(fixture).startsWith('workspace-bridge-integration-')) throw new Error('Invalid test cleanup target.');
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
