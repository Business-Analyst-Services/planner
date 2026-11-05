'use strict';
// Daycraft server for local use and Docker: serves public/ and the /api/circle and /api/boards APIs.
// Zero dependencies. Data goes to a JSON file (DATA_FILE), or to Upstash Redis when configured.
// On Vercel the same API runs as functions in api/ instead (see vercel.json).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleRequest } = require('./lib/core');
const { dbFromEnv } = require('./lib/storage');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_REQUEST = 3.5 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const ROUTES = { '/': 'index.html', '/circle': 'circle.html', '/boards': 'boards.html' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// ---------- HTTP ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_REQUEST) { resolve(null); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
  let rel = ROUTES[pathname] || ROUTES[pathname.replace(/\/$/, '')] || decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    const ext = path.extname(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function createApp({ dataFile } = {}) {
  const db = dbFromEnv(process.env, { file: dataFile });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    const rawBody = req.method === 'POST' ? await readBody(req) : '';
    if (rawBody === null) return sendJson(res, 413, { error: 'Request too large.' });
    const { status, body } = await handleRequest(db, {
      method: req.method, pathname: url.pathname, query: url.searchParams,
      authorization: req.headers.authorization || '', rawBody, ip: req.socket.remoteAddress || '',
    });
    sendJson(res, status, body);
  });
  return { server, db };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server, db } = createApp();
  server.listen(port, () => console.log(`Daycraft running at http://localhost:${port} (storage: ${db.kind})`));
}
