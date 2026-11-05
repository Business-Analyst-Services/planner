'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server');
const { viewKeyFor } = require('../boards-api');

const key = () => crypto.randomBytes(32).toString('hex');
const doc = () => ({
  type: 'kanban', name: 'Team', sprintDays: 14,
  columns: [{ id: 'todo', name: 'To do', wip: null }, { id: 'doing', name: 'Doing', wip: 2 }, { id: 'done', name: 'Done', wip: 5 }],
  cards: [{ id: 'c1', title: 'First', type: 'task', priority: 'high', points: 3, column: 'todo', labels: ['a', 'a', ''], history: [{ column: 'todo', at: new Date().toISOString() }], created: new Date().toISOString(), evil: '<x>' }],
  sprints: [], standups: [],
});

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daycraft-boards-'));
  const { server } = createApp({ dataFile: path.join(dir, 'data.json') });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (mode, { k, id, since, body } = {}) => {
    const q = new URLSearchParams({ mode, ...(id ? { id } : {}), ...(since != null ? { since } : {}) });
    const res = await fetch(`${base}/api/boards?${q}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(k ? { Authorization: 'Bearer ' + k } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };
  try { await fn({ api, dir }); } finally { server.close(); }
}

test('share, read, patch and merge concurrent edits', () => withServer(async ({ api, dir }) => {
  const edit = key(), view = viewKeyFor(edit);
  const created = await api('create', { k: edit, body: { doc: doc() } });
  assert.equal(created.status, 200);
  const { id } = created.json;
  assert.equal(created.json.rev, 1);
  const c1 = created.json.doc.cards[0];
  assert.equal(c1.evil, undefined, 'unknown fields stripped');
  assert.deepEqual(c1.labels, ['a'], 'labels deduped and cleaned');
  assert.equal(created.json.doc.columns[2].wip, null, 'no WIP limit on Done');

  // view link reads, cannot write
  const viewed = await api('get', { k: view, id });
  assert.equal(viewed.json.role, 'view');
  assert.equal((await api('patch', { k: view, id, body: { ops: { set: { name: 'x' } } } })).status, 403);
  assert.equal((await api('get', { k: key(), id })).status, 404, 'wrong key looks like a missing board');
  assert.equal((await api('get', { k: edit, id, since: 1 })).json.unchanged, true);

  // two editors working from the same base revision on different cards both survive
  await api('patch', { k: edit, id, body: { baseRev: 1, ops: { upsert: { cards: [{ ...c1, column: 'doing' }] } } } });
  const r = await api('patch', { k: edit, id, body: { baseRev: 1, ops: { upsert: { cards: [{ id: 'c2', title: 'Second', column: 'todo' }] }, set: { name: 'Team board' } } } });
  assert.equal(r.json.rev, 3);
  assert.deepEqual(r.json.doc.cards.map(c => [c.id, c.column]), [['c1', 'doing'], ['c2', 'todo']]);
  assert.equal(r.json.doc.name, 'Team board');

  const removed = await api('patch', { k: edit, id, body: { ops: { remove: { cards: ['c1'] } } } });
  assert.deepEqual(removed.json.doc.cards.map(c => c.id), ['c2']);
  assert.equal((await api('patch', { k: edit, id, body: { ops: { set: { type: 'scrum' } } } })).status, 400, 'type is fixed');
  assert.equal((await api('patch', { k: edit, id, body: { ops: { set: { columns: [{ id: 'only', name: 'x' }] } } } })).status, 400);

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  assert.equal(saved.boards[id].rev, 4);
  assert.ok(!JSON.stringify(saved).includes(edit), 'keys are never stored in plain text');

  assert.equal((await api('delete', { k: view, id, body: {} })).status, 403);
  assert.equal((await api('delete', { k: edit, id, body: {} })).json.deleted, true);
  assert.equal((await api('get', { k: edit, id })).status, 404);
}));

test('rejects invalid boards', () => withServer(async ({ api }) => {
  assert.equal((await api('create', { k: 'short', body: { doc: doc() } })).status, 400);
  assert.equal((await api('create', { k: key(), body: { doc: { ...doc(), type: 'other' } } })).status, 400);
  assert.equal((await api('create', { k: key(), body: { doc: { ...doc(), cards: [{ id: 'bad id!', column: 'todo' }] } } })).status, 400);
  assert.equal((await api('get', { k: key(), id: 'nope' })).status, 404);
}));
