'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp, mondayOf } = require('../server');

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const week = mondayOf(today);
const key = () => crypto.randomBytes(32).toString('hex');

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycraft-'));
  const { server } = createApp({ dataFile: path.join(dir, 'circle.json') });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (mode, { k, body, w = week } = {}) => {
    const res = await fetch(`${base}/api/circle?mode=${mode}&week=${w}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(k ? { Authorization: 'Bearer ' + k } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };
  try { await fn({ base, api, dir }); } finally { server.close(); }
}

test('serves planner pages and assets', () => withServer(async ({ base }) => {
  for (const [p, type] of [['/', 'text/html'], ['/circle', 'text/html'], ['/boards', 'text/html'], ['/boards.js', 'text/javascript'], ['/app.js', 'text/javascript'], ['/circle.css', 'text/css']]) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), new RegExp(type));
  }
  assert.equal((await fetch(base + '/../server.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404);
}));

test('claim, commit, check in, comment and board view', () => withServer(async ({ api }) => {
  const a = key(), b = key();
  assert.equal((await api('me', { k: a })).status, 401);
  assert.equal((await api('claim', { k: a, body: { name: 'Ann', consent: true } })).status, 200);
  // idempotent re-claim
  assert.equal((await api('claim', { k: a, body: { name: 'Ann', consent: true } })).json.member.slot, 1);
  assert.equal((await api('claim', { k: b, body: { name: 'Bo', consent: false } })).status, 400);
  assert.equal((await api('claim', { k: b, body: { name: 'Bo', consent: true } })).json.member.slot, 2);

  assert.equal((await api('log', { k: a, body: { id: crypto.randomUUID(), date: week, status: 'done' } })).status, 409, 'needs commitment first');
  assert.equal((await api('save', { k: a, body: { action: 'Swim', goal: 2, timezone: 'Australia/Adelaide' } })).status, 200);
  assert.equal((await api('save', { k: a, body: { action: 'Swim', goal: 2, createOnly: true } })).status, 409);
  assert.equal((await api('schedule', { k: a, body: { day: week, time: '07:30', duration: 45, timezone: 'Australia/Adelaide' } })).status, 200);
  assert.equal((await api('schedule', { k: a, body: { day: week, time: '07:30', duration: 45, timezone: 'Not/AZone' } })).status, 400);

  const l1 = crypto.randomUUID(), l2 = crypto.randomUUID();
  await api('log', { k: a, body: { id: l1, date: week, status: 'done', reflection: 'secret', shareReflection: false } });
  await api('log', { k: a, body: { id: l2, date: week, status: 'partial', reflection: 'shared note', shareReflection: true } });
  assert.equal((await api('log', { k: b, body: { id: l1, action: 'remove' } })).status, 403);

  const c = crypto.randomUUID();
  assert.equal((await api('comment', { k: b, body: { id: c, targetSlot: 1, text: 'Go Ann!', consent: true } })).status, 200);
  assert.equal((await api('comment', { k: b, body: { id: c, targetSlot: 1, text: 'Go Ann!', consent: true } })).status, 200, 'idempotent');
  assert.equal((await api('comment', { k: a, body: { id: c, action: 'remove' } })).status, 403);

  const board = (await api('board')).json;
  assert.equal(board.count, 2);
  const ann = board.members.find(m => m.slot === 1);
  assert.deepEqual(ann.summary, { completed: 1, goal: 2, status: 'partial', checkins: 2 });
  assert.equal(ann.timeline.length, 13);
  assert.equal(ann.comments.length, 1);
  assert.equal(ann.comments[0].author_name, 'Bo');
  assert.equal(ann.entry.day, undefined, 'schedule is private');
  assert.deepEqual(ann.logs.map(l => l.reflection), [null, 'shared note'], 'private reflections hidden');
  assert.ok(!JSON.stringify(board).includes('key_hash'));

  const me = (await api('me', { k: a })).json;
  assert.equal(me.entry.time, '07:30');
  assert.equal(me.logs.find(l => l.id === l1).reflection, 'secret');

  await api('log', { k: a, body: { id: l1, action: 'remove' } });
  assert.equal((await api('board')).json.members[0].summary.completed, 0);
  assert.equal((await api('me', { k: a })).json.logs.find(l => l.id === l1).deleted, 1);
}));

test('rejects bad weeks, enforces capacity and persists to disk', () => withServer(async ({ api, dir }) => {
  assert.equal((await api('board', { w: '2026-13-01' })).status, 400);
  assert.equal((await api('board', { w: mondayOf(today).replace(/\d\d$/, d => String(Number(d) + 1).padStart(2, '0')) })).status, 400);
  for (let i = 0; i < 10; i++) assert.equal((await api('claim', { k: key(), body: { name: 'P' + i, consent: true } })).status, 200);
  assert.equal((await api('claim', { k: key(), body: { name: 'Late', consent: true } })).status, 409);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'circle.json'), 'utf8'));
  assert.equal(saved.members.length, 10);
}));
