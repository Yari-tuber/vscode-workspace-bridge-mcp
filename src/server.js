'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMcpServer } = require('./tools');

function json(res, status, value) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
function tokenMatches(header, token) {
  if (typeof header !== 'string' || header.length > 300 || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)); const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
function validHostname(hostname) { return typeof hostname === 'string' && hostname.length <= 253 && /^(?:localhost|127\.0\.0\.1|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+)$/i.test(hostname); }
async function startServer({ host, token, port = 3338, allowedHosts = [], audit = () => {} }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('A random 32-byte hex token is required.');
  if (!Number.isInteger(port) || port < 0 || port > 65525) throw new Error('Invalid port.');
  if (!Array.isArray(allowedHosts) || !allowedHosts.every(validHostname)) throw new Error('Allowed hosts must be exact hostnames, without scheme, port or wildcard.');
  let closed = false, active = 0, count = 0, windowStart = Date.now();
  const transports = new Set();
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => { json(res, 500, { error: 'Request failed.' }); });
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000; server.timeout = 35000; server.keepAliveTimeout = 3000;
  server.maxHeadersCount = 40;
  server.maxConnections = 64;
  async function handle(req, res) {
    const localPort = server.address().port;
    const acceptable = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`, ...allowedHosts.map(h => h.toLowerCase()), ...allowedHosts.map(h => `${h.toLowerCase()}:443`)]);
    if (typeof req.headers.host !== 'string' || !acceptable.has(req.headers.host.toLowerCase())) return json(res, 403, { error: 'Host is not allowed.' });
    if (req.headers.origin) {
      let origin; try { origin = new URL(req.headers.origin); } catch { return json(res, 403, { error: 'Origin is not allowed.' }); }
      const local = origin.origin === `http://127.0.0.1:${localPort}` || origin.origin === `http://localhost:${localPort}`;
      const remote = origin.protocol === 'https:' && allowedHosts.includes(origin.hostname) && (!origin.port || origin.port === '443');
      if ((!local && !remote) || origin.username || origin.password) return json(res, 403, { error: 'Origin is not allowed.' });
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="Workspace Bridge"');
      return json(res, 401, { error: 'A valid bearer token is required.' });
    }
    if (Date.now() - windowStart > 60000) { windowStart = Date.now(); count = 0; }
    if (++count > 240 || active >= 6 || closed) return json(res, 429, { error: 'Too many authenticated requests. Retry shortly.' });
    if (req.url === '/health' && req.method === 'GET') return json(res, 200, { status: 'ready', version: '0.1.0' });
    if (req.url !== '/mcp') return json(res, 404, { error: 'Not found.' });
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Use stateless Streamable HTTP POST.' }); }
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'Use application/json.' });
    if (Number(req.headers['content-length']) > 512 * 1024) return json(res, 413, { error: 'Request exceeds 512 KiB.' });
    active++;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 512 * 1024) return json(res, 413, { error: 'Request exceeds 512 KiB.' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || ('id' in body && typeof body.id !== 'string' && typeof body.id !== 'number')) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Expected a JSON-RPC request or notification.' } });
      const mcp = createMcpServer(host, audit);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      transports.add(transport);
      const cleanup = () => { transports.delete(transport); void mcp.close().catch(() => {}); };
      res.once('close', cleanup);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally { active--; }
  }
  let listeningPort = port;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const error = err => { server.off('listening', ready); reject(err); };
        const ready = () => { server.off('error', error); resolve(); };
        server.once('error', error); server.once('listening', ready); server.listen(listeningPort, '127.0.0.1');
      });
      break;
    } catch (error) { if (error.code !== 'EADDRINUSE' || !port || attempt >= 9) throw error; listeningPort++; }
  }
  const actualPort = server.address().port;
  return { port: actualPort, url: `http://127.0.0.1:${actualPort}/mcp`, async close() {
    if (closed) return; closed = true;
    await Promise.allSettled([...transports].map(t => t.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}
module.exports = { startServer, tokenMatches };
