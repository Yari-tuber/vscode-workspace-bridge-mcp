'use strict';
const fs = require('node:fs');
const { build } = require('esbuild');
fs.mkdirSync('dist', { recursive: true });
fs.mkdirSync('artifacts', { recursive: true });
build({entryPoints:['src/extension.js'],bundle:true,outfile:'dist/extension.js',platform:'node',format:'cjs',target:'node20',external:['vscode'],minify:true,legalComments:'eof',sourcemap:false,metafile:true})
  .then(result => fs.writeFileSync('artifacts/bundle-meta.json', JSON.stringify(result.metafile, null, 2)))
  .catch(() => process.exitCode=1);
