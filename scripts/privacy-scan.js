#!/usr/bin/env node
'use strict';

// This scanner reports locations and rule names, never the matching content.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOTS = new Set(['src', 'test', 'scripts', 'docs', '.github', 'assets', 'media', 'icons']);
const SOURCE_FILES = new Set([
  'package.json', 'package-lock.json', 'package.nls.json', 'package.nls.zh-cn.json', 'tsconfig.json', 'jsconfig.json',
  '.gitignore', '.vscodeignore', '.gitattributes', '.editorconfig',
  'README.md', 'README.zh-CN.md', 'README.en.md', 'LICENSE', 'LICENSE.md',
  'NOTICE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md',
]);
const MAX_FILE = 12 * 1024 * 1024;
const MAX_ARCHIVE = 80 * 1024 * 1024;
const findings = [];
let inspected = 0;

function fail(file, rule, line) {
  findings.push({ file, rule, ...(line ? { line } : {}) });
}

function unsafeName(name) {
  const clean = name.replaceAll('\\', '/');
  if (clean.startsWith('/') || /^[a-z]:/i.test(clean) || clean.split('/').includes('..')) return 'unsafe archive or source path';
  for (const component of clean.split('/')) {
    if (/^\.env(?:\.|$)/i.test(component)) return 'environment file';
    if (/^(?:credentials?(?:\..*)?|secrets?(?:\..*)?|route-state\.json|tunnel\.(?:ya?ml|json)|diagnostics(?:-events)?\.(?:json|jsonl))$/i.test(component)) return 'private runtime or credential file';
    if (/^(?:runtime|focus|node_modules|\.git|\.ssh|\.aws|\.azure|\.codex|backups?|backup-.+)$/i.test(component)) return 'private runtime or dependency directory';
    if (/\.(?:log|jsonl|pem|key|p12|pfx|vsix|zip)$/i.test(component)) return 'log, credential, or nested archive';
    if (/^(?:id_rsa|id_ed25519|\.npmrc|\.netrc|\.pypirc)$/i.test(component)) return 'credential file';
  }
  return null;
}

function placeholder(value) {
  return /^(?:<[^>]+>|\$\{[^}]+\}|\*+|\[REDACTED[^\]]*\])$/i.test(value) ||
    /^(?:YOUR[_-]|REPLACE[_-]|EXAMPLE[_-]|TEST[_-]|DUMMY[_-]|PLACEHOLDER|not[-_]a[-_]real|redacted)/i.test(value);
}

function privatePatterns() {
  const patterns = (process.env.PRIVACY_BLOCK_PATTERNS || '').split(/\r?\n/).filter(Boolean);
  return patterns.map((source, index) => {
    try { return { regex: new RegExp(source, 'i'), label: `private pattern ${index + 1}` }; }
    catch { throw new Error(`PRIVACY_BLOCK_PATTERNS entry ${index + 1} is not a valid regular expression`); }
  });
}

function scanText(file, text, blocked) {
  const rules = [
    ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
    ['personal absolute Windows path', /(?<![A-Za-z0-9])[a-z]:[\\/]+/i],
    ['personal absolute home path', /\/(?:Users|home)\/(?!<|\$\{|example(?:\/|$)|username(?:\/|$))[^\s/"'<>]+\//],
    ['provider token', /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|live-)?[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/],
    ['JWT token', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
    ...blocked.map(x => [x.label, x.regex]),
  ];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [label, regex] of rules) if (regex.test(line)) fail(file, label, i + 1);
    const assignment = /(?:["']?(?:api[_-]?key|auth[_-]?token|access[_-]?token|token|password|secret)["']?)\s*[:=]\s*["']([^"'\r\n]{12,})["']/ig;
    for (const match of line.matchAll(assignment)) {
      const value = match[1];
      if (!placeholder(value) && !/\s|\b(?:process\.|config\.|options\.|crypto\.|random|function|typeof|require)\b/.test(value) && /[A-Za-z]/.test(value)) {
        fail(file, 'literal credential assignment', i + 1);
      }
    }
    for (const match of line.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      const octets = match[0].split('.').map(Number);
      if (octets.some(n => n > 255)) continue;
      const [a, b, c] = octets;
      const example = (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
      if (a !== 127 && match[0] !== '0.0.0.0' && !example) fail(file, 'nonexample IP address', i + 1);
    }
    for (const match of line.matchAll(/https?:\/\/([^\s/"'<>]+)/ig)) {
      if (match[1].includes('@')) fail(file, 'URL credential', i + 1);
      if (/\.trycloudflare\.com(?::\d+)?$/i.test(match[1]) && !/^(?:your|example|placeholder)[.-]/i.test(match[1])) fail(file, 'temporary tunnel hostname', i + 1);
    }
  }
}

function inspect(file, buffer, blocked) {
  const issue = unsafeName(file);
  if (issue) { fail(file, issue); return; }
  if (buffer.length > MAX_FILE) { fail(file, 'file exceeds privacy scan limit'); return; }
  inspected++;
  if (buffer.includes(0)) {
    if (!/\.(?:png|jpe?g|webp|gif|ico|woff2?|ttf|otf)$/i.test(file)) fail(file, 'unexpected binary publication file');
    return;
  }
  scanText(file, buffer.toString('utf8'), blocked);
}

function fallbackFiles(dir = ROOT, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && !SOURCE_FILES.has(entry.name) && !SOURCE_ROOTS.has(entry.name)) continue;
    if (entry.isSymbolicLink()) { fail(relative, 'symlink in publication source'); continue; }
    if (entry.isDirectory()) result.push(...fallbackFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

function sourceFiles() {
  const git = spawnSync('git', ['-C', ROOT, 'ls-files', '--cached', '--exclude-standard', '-z'], { encoding: 'utf8', windowsHide: true, maxBuffer: MAX_FILE });
  if (git.status === 0) return git.stdout.split('\0').filter(Boolean);
  return fallbackFiles();
}

function inspectVsix(filename, blocked) {
  const zip = fs.readFileSync(filename);
  if (zip.length > MAX_ARCHIVE) throw new Error('VSIX exceeds the archive size limit');
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid VSIX ZIP directory');
  const entries = zip.readUInt16LE(eocd + 10);
  const disk = zip.readUInt16LE(eocd + 4);
  const centralSize = zip.readUInt32LE(eocd + 12);
  let offset = zip.readUInt32LE(eocd + 16);
  if (disk || zip.readUInt16LE(eocd + 6) || entries === 0xffff || offset + centralSize > eocd) throw new Error('Unsupported multidisk or ZIP64 VSIX');
  const names = new Set();
  let total = 0;
  let manifest = false;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid VSIX central entry');
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 24);
    const compressed = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const externalMode = zip.readUInt32LE(offset + 38) >>> 16;
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    const nameIssue = unsafeName(name);
    if (nameIssue) { fail(name, nameIssue); continue; }
    if ((externalMode & 0xf000) === 0xa000) { fail(name, 'symlink in VSIX'); continue; }
    if (name.endsWith('/')) continue;
    if (names.has(name.toLowerCase())) throw new Error('Duplicate VSIX entry');
    names.add(name.toLowerCase());
    if (name === 'extension.vsixmanifest') manifest = true;
    if ((flags & 1) || ![0, 8].includes(method)) throw new Error('Encrypted or unsupported VSIX entry');
    total += size;
    if (size > MAX_FILE || total > MAX_ARCHIVE) throw new Error('VSIX decompression limit exceeded');
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid VSIX local entry');
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (dataStart + compressed > zip.length) throw new Error('Truncated VSIX entry');
    const raw = zip.subarray(dataStart, dataStart + compressed);
    const data = method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: MAX_FILE }) : raw;
    if (data.length !== size) throw new Error('VSIX size mismatch');
    inspect(name, data, blocked);
  }
  if (!manifest || !names.has('extension/package.json')) throw new Error('VSIX manifest or extension package is missing');
}

function main() {
  const args = process.argv.slice(2);
  let vsix;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--vsix' || !args[i + 1] || vsix) throw new Error('Usage: node scripts/privacy-scan.js [--vsix <file>]');
    vsix = path.resolve(args[++i]);
  }
  const blocked = privatePatterns();
  for (const file of sourceFiles()) {
    const full = path.resolve(ROOT, file);
    const relative = path.relative(ROOT, full);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { fail(file, 'source escapes project'); continue; }
    if (!fs.existsSync(full)) { fail(file, 'tracked publication file is missing'); continue; }
    if (fs.lstatSync(full).isSymbolicLink()) { fail(file, 'symlink in publication source'); continue; }
    inspect(file, fs.readFileSync(full), blocked);
  }
  if (vsix) inspectVsix(vsix, blocked);
  if (findings.length) {
    for (const finding of findings) process.stderr.write(`${finding.file}${finding.line ? `:${finding.line}` : ''}: ${finding.rule}\n`);
    process.stderr.write(`Privacy scan failed: ${findings.length} finding(s). Matching values are withheld.\n`);
    process.exitCode = 1;
  } else process.stdout.write(`Privacy scan passed: ${inspected} publication files inspected${vsix ? ', including VSIX contents' : ''}.\n`);
}

try { main(); } catch (error) {
  // OS errors can contain private absolute paths. Deliberately do not echo them.
  process.stderr.write(`Privacy scan could not complete (${error.code || 'invalid input or archive'}).\n`);
  process.exitCode = 1;
}
