'use strict';
// Adapter from a Vercel Node function to the shared request handler.
const { handleRequest } = require('./core');
const { dbFromEnv } = require('./storage');

let db;
async function rawBodyOf(req) {
  if (req.method !== 'POST') return '';
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = pathname => async (req, res) => {
  if (db === undefined) db = dbFromEnv();
  const url = new URL(req.url, 'http://localhost');
  const { status, body } = await handleRequest(db, {
    method: req.method, pathname, query: url.searchParams,
    authorization: req.headers.authorization || '', rawBody: await rawBodyOf(req),
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '',
  });
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};
