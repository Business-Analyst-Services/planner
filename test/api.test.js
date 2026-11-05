'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server');
const { mondayOf } = require('../lib/circle-api');

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const week = mondayOf(today);
const key = () => crypto.randomBytes(32).toString('hex');

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycraft-'));
  const { server } = createApp({ dataFile: path.join(dir, 'daycraft.json') });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (mode, { k, body, w = week, period } = {}) => {
    const res = await fetch(`${base}/api/circle?mode=${mode}&week=${w}${period ? '&period=' + period : ''}`, {
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
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'daycraft.json'), 'utf8')).records.circle;
  assert.equal(saved.members.length, 10);
}));

test('monthly and quarterly commitments are separate from weekly ones', () => withServer(async ({ api }) => {
  const { periodStart, periodEnd } = require('../lib/circle-api');
  const a = key();
  await api('claim', { k: a, body: { name: 'Ann', consent: true } });
  const month = periodStart('month', today), quarter = periodStart('quarter', today);
  assert.equal((await api('board', { w: week, period: 'month' })).status, month === week ? 200 : 400, 'start must be the 1st');
  assert.equal((await api('board', { w: month, period: 'decade' })).status, 400);
  assert.equal((await api('save', { k: a, w: month, period: 'month', body: { action: 'Read 4 books', goal: 30 } })).status, 200, 'monthly goals can exceed 21');
  assert.equal((await api('save', { k: a, w: quarter, period: 'quarter', body: { action: 'Ship v2', goal: 1 } })).status, 200);
  // a check-in late in the month is valid for the month even if outside the current week
  const end = periodEnd('month', month);
  assert.equal((await api('log', { k: a, w: month, period: 'month', body: { id: crypto.randomUUID(), date: end, status: 'done' } })).status, 200);
  const { addDays } = require('../lib/circle-api');
  assert.equal((await api('log', { k: a, w: month, period: 'month', body: { id: crypto.randomUUID(), date: addDays(end, 1), status: 'done' } })).status, 400, 'dates outside the month are rejected');
  const mb = (await api('board', { w: month, period: 'month' })).json;
  assert.equal(mb.period, 'month'); assert.equal(mb.end, end);
  assert.equal(mb.members[0].entry.action, 'Read 4 books');
  assert.equal(mb.members[0].summary.completed, 1);
  assert.equal(mb.members[0].timeline.length, 13);
  const wb = (await api('board')).json;
  assert.equal(wb.members[0].entry, null, 'weekly board is unaffected');
  const qb = (await api('board', { w: quarter, period: 'quarter' })).json;
  assert.equal(qb.members[0].entry.action, 'Ship v2');
  const me = (await api('me', { k: a, w: month, period: 'month' })).json;
  assert.equal(me.entry.week, month);
}));
