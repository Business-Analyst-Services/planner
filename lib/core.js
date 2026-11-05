'use strict';
// Request handling for /api/circle and /api/boards, shared by the Node server and Vercel functions.

const crypto = require('node:crypto');
const { handleApi, rateLimit, HttpError, emptyCircle } = require('./circle-api');
const { handleBoards, BoardsError, MAX_PROJECTS } = require('./boards-api');

const MAX_BODY = 16 * 1024;
const MAX_BOARD_BODY = 3 * 1024 * 1024;

function parseBody(method, raw, limit) {
  if (method !== 'POST') return {};
  if (raw && Buffer.byteLength(raw) > limit) throw new HttpError(413, 'Request too large.');
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request body.');
  return body;
}

// A small adapter so the existing handlers can keep using `store.data` / `store.save()`.
const asStore = data => ({ data, save() {} });

async function handleRequest(db, { method, pathname, query, authorization = '', rawBody = '', ip = '' }) {
  try {
    if (!db) throw new HttpError(503, 'Storage is not configured on this server. Connect a Vercel Blob store or Upstash Redis (see README).');
    const key = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

    if (pathname === '/api/circle') {
      const body = parseBody(method, rawBody, MAX_BODY);
      const result = await db.transact('circle', state => {
        state.value = state.value || emptyCircle();
        return handleApi(asStore(state.value), { method, mode: query.get('mode') || 'board', week: query.get('start') || query.get('week'), period: query.get('period') || 'week', key, body, ip });
      });
      return { status: 200, body: result };
    }

    if (pathname === '/api/boards') {
      const body = parseBody(method, rawBody, MAX_BOARD_BODY);
      const mode = query.get('mode') || 'get';
      const id = mode === 'create' ? crypto.randomUUID() : query.get('id');
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new BoardsError(404, 'This shared board does not exist, or your link is no longer valid.');
      if (mode === 'create' && (await db.count('board:')) >= MAX_PROJECTS) throw new BoardsError(507, 'The server has reached its shared board limit.');
      const result = await db.transact('board:' + id, state => {
        const boards = state.value ? { [id]: state.value } : {};
        const out = handleBoards(asStore({ boards }), {
          method, mode, projectId: id, newId: id, since: query.get('since'), key, body, ip,
          rateLimit: addr => rateLimit(addr, 'boards', 30),
        });
        state.value = boards[id] || null;
        return out;
      });
      return { status: 200, body: result };
    }
    return { status: 404, body: { error: 'Not found.' } };
  } catch (e) {
    const known = e instanceof HttpError || e instanceof BoardsError || (e.status && e.message);
    if (!known) console.error(e);
    return { status: known ? e.status : 500, body: { error: known ? e.message : 'Something went wrong. Try again.' } };
  }
}

module.exports = { handleRequest };
