'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');
const result = spawnSync(process.execPath, [path.join(__dirname, 'privacy-scan.js'), '--vsix', path.join('artifacts', `workspace-bridge-mcp-${version}.vsix`)], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
