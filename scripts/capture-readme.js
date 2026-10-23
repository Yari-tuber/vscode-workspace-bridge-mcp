'use strict';
// Opens an isolated, synthetic workspace for real documentation screenshots.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');
async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-readme-'));
  const workspace = path.join(temp, 'bridge-demo');
  const profile = path.join(temp, 'profile');
  const ready = path.join(root, 'artifacts', 'readme-demo-ready.json');
  const stop = path.join(root, 'artifacts', 'readme-demo-stop');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await fs.rm(ready, { force: true }); await fs.rm(stop, { force: true });
  await fs.writeFile(path.join(workspace, 'src', 'cart.js'), [
    '/** Calculate the total for a shopping cart. */',
    'export function cartTotal(items) {',
    '  return items.reduce((sum, item) => {',
    '    return sum + item.price * item.quantity;',
    '  }, 0);',
    '}', '',
    'const cart = [',
    '  { name: "Notebook", price: 12, quantity: 2 },',
    '  { name: "Pencil", price: 3, quantity: 4 },',
    '];', '',
    'console.log(cartTotal(cart));', ''
  ].join('\n'));
  await fs.writeFile(path.join(workspace, 'README.md'), '# Bridge demo\n\nSynthetic sample data for documentation screenshots.\n');
  await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'window.title': 'Workspace Bridge MCP · Demo', 'window.zoomLevel': 0,
    'workbench.colorTheme': 'Default Dark Modern', 'workbench.startupEditor': 'none',
    'editor.minimap.enabled': false, 'editor.fontSize': 15, 'telemetry.telemetryLevel': 'off',
    'chat.disableAIFeatures': true, 'workbench.tips.enabled': false
  }));
  try {
    await runTests({ version: process.env.VSCODE_TEST_VERSION || 'insiders',
      extensionDevelopmentPath: root, extensionTestsPath: path.join(__dirname, 'capture-readme-suite.js'),
      extensionTestsEnv: { BRIDGE_DEMO_READY: ready, BRIDGE_DEMO_STOP: stop },
      launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(temp, 'extensions'), '--locale', 'en', '--disable-workspace-trust', '--disable-telemetry', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-gpu']
    });
  } finally {
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temp).startsWith('bridge-readme-')) throw new Error('Invalid screenshot fixture cleanup target.');
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    await fs.rm(ready, { force: true }); await fs.rm(stop, { force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
