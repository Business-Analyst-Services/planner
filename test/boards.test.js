'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server');

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

test('share, members, roles and concurrent edits', () => withServer(async ({ api, dir }) => {
  const ann = key(), bo = key(), cy = key(), pub = key();
  const created = await api('create', { k: ann, body: { doc: doc(), name: 'Ann' } });
  assert.equal(created.status, 200);
  const { id } = created.json;
  assert.equal(created.json.role, 'owner');
  assert.equal(created.json.me.name, 'Ann');
  const c1 = created.json.doc.cards[0];
  assert.equal(c1.evil, undefined, 'unknown fields stripped');
  assert.deepEqual(c1.labels, ['a']);
  assert.equal(created.json.doc.columns[2].wip, null, 'no WIP limit on Done');

  // invites
  const inv = await api('invite', { k: ann, id, body: { name: 'Bo', role: 'editor', key: bo } });
  assert.equal(inv.status, 200);
  assert.equal(inv.json.member.name, 'Bo');
  assert.equal((await api('invite', { k: ann, id, body: { name: 'bo', role: 'viewer', key: key() } })).status, 409, 'names are unique');
  await api('invite', { k: ann, id, body: { name: 'Cy', role: 'viewer', key: cy } });
  assert.equal((await api('invite', { k: bo, id, body: { name: 'Dee', key: key() } })).status, 403, 'only owners invite');

  const asBo = await api('get', { k: bo, id });
  assert.equal(asBo.json.role, 'editor');
  assert.equal(asBo.json.members.length, 3);
  assert.ok(!JSON.stringify(asBo.json).includes('key_hash'));
  assert.equal(asBo.json.viewLink, undefined, 'only owners see view link status');
  assert.equal((await api('patch', { k: cy, id, body: { ops: { set: { name: 'x' } } } })).status, 403, 'viewers cannot edit');
  assert.equal((await api('get', { k: key(), id })).status, 404);

  // concurrent edits from the same base by two editors both survive, with attribution
  await api('patch', { k: ann, id, body: { baseRev: 1, ops: { upsert: { cards: [{ ...c1, column: 'doing' }] } } } });
  const r = await api('patch', { k: bo, id, body: { baseRev: 1, ops: { upsert: { cards: [{ id: 'c2', title: 'Second', column: 'todo' }] }, set: { name: 'Team board' } } } });
  assert.deepEqual(r.json.doc.cards.map(c => [c.id, c.column, c.updatedBy]), [['c1', 'doing', 'Ann'], ['c2', 'todo', 'Bo']]);
  assert.equal(r.json.doc.name, 'Team board');
  assert.match(r.json.activity[0].summary, /added “Second”.*renamed the board/);
  assert.equal(r.json.activity[0].by, 'Bo');
  assert.equal((await api('patch', { k: ann, id, body: { ops: { set: { type: 'scrum' } } } })).status, 400, 'type is fixed');
  assert.equal((await api('patch', { k: ann, id, body: { ops: { set: { columns: [{ id: 'only', name: 'x' }] } } } })).status, 400);

  // roles
  const boId = inv.json.member.id;
  await api('member', { k: ann, id, body: { memberId: boId, role: 'viewer' } });
  assert.equal((await api('patch', { k: bo, id, body: { ops: { set: { name: 'y' } } } })).status, 403, 'demoted editor cannot edit');
  const annId = created.json.me.id;
  assert.equal((await api('member', { k: ann, id, body: { memberId: annId, role: 'editor' } })).status, 409, 'last owner stays');
  assert.equal((await api('leave', { k: ann, id, body: {} })).status, 409, 'last owner cannot leave others behind');

  // link rotation: own link and someone else's
  const bo2 = key();
  assert.equal((await api('rotate', { k: bo, id, body: { key: bo2 } })).json.me.name, 'Bo');
  assert.equal((await api('get', { k: bo, id })).status, 404, 'old link stops working');
  assert.equal((await api('get', { k: bo2, id })).status, 200);
  assert.equal((await api('rotate', { k: bo2, id, body: { memberId: annId, key: key() } })).status, 403, 'only owners reset others');
  const cy2 = key();
  await api('rotate', { k: ann, id, body: { memberId: (await api('get', { k: cy, id })).json.me.id, key: cy2 } });
  assert.equal((await api('get', { k: cy, id })).status, 404);
  assert.equal((await api('rotate', { k: ann, id, body: { key: bo2 } })).status, 409, 'keys cannot be reused');

  // public view link
  await api('viewlink', { k: ann, id, body: { action: 'enable', key: pub } });
  const pv = await api('get', { k: pub, id });
  assert.equal(pv.json.role, 'public');
  assert.equal(pv.json.members, undefined, 'public link does not list members');
  assert.equal((await api('patch', { k: pub, id, body: { ops: {} } })).status, 403);
  const pub2 = key();
  await api('viewlink', { k: ann, id, body: { action: 'rotate', key: pub2 } });
  assert.equal((await api('get', { k: pub, id })).status, 404);
  await api('viewlink', { k: ann, id, body: { action: 'disable' } });
  assert.equal((await api('get', { k: pub2, id })).status, 404);

  // removal
  await api('member', { k: ann, id, body: { memberId: boId, remove: true } });
  assert.equal((await api('get', { k: bo2, id })).status, 404);
  const final = await api('get', { k: ann, id });
  assert.deepEqual(final.json.members.map(m => m.name), ['Ann', 'Cy']);
  assert.equal((await api('get', { k: ann, id, since: final.json.rev })).json.unchanged, true);

  const saved = fs.readFileSync(path.join(dir, 'data.json'), 'utf8');
  for (const k of [ann, bo, bo2, cy, pub]) assert.ok(!saved.includes(k), 'keys are never stored in plain text');

  assert.equal((await api('delete', { k: cy2, id, body: {} })).status, 403);
  assert.equal((await api('delete', { k: ann, id, body: {} })).json.deleted, true);
  assert.equal((await api('get', { k: ann, id })).status, 404);
}));

test('rejects invalid boards', () => withServer(async ({ api }) => {
  assert.equal((await api('create', { k: 'short', body: { doc: doc(), name: 'A' } })).status, 400);
  assert.equal((await api('create', { k: key(), body: { doc: doc(), name: '' } })).status, 400);
  assert.equal((await api('create', { k: key(), body: { doc: { ...doc(), type: 'other' }, name: 'A' } })).status, 400);
  assert.equal((await api('create', { k: key(), body: { doc: { ...doc(), cards: [{ id: 'bad id!', column: 'todo' }] }, name: 'A' } })).status, 400);
  assert.equal((await api('get', { k: key(), id: 'nope' })).status, 404);
}));
