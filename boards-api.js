'use strict';
// Shared Boards API: /api/boards
//
// A shared project is a JSON document (columns, cards, sprints, stand-ups) stored on the server.
// Access is by secret link, like My Group: the edit key (64 hex chars) lets you change the board;
// the view key — derived on the client as sha256(editKey + ':view') — gives read-only access.
// Only SHA-256 hashes of the keys are stored.
//
// Clients send changes as entity-level patches (upsert/remove cards, sprints and stand-ups by id,
// set top-level fields). Patches apply to the latest revision, so two people editing different
// cards never overwrite each other; edits to the same card resolve last-writer-wins.

const crypto = require('node:crypto');

const LIMITS = { cards: 3000, sprints: 300, standups: 2000, docBytes: 2 * 1024 * 1024 };
const MAX_PROJECTS = Number(process.env.BOARDS_MAX_PROJECTS) || 500;
const COLLECTIONS = ['cards', 'sprints', 'standups'];
const FIELDS = ['name', 'sprintDays', 'columns'];
const TYPES = ['story', 'task', 'bug', 'spike', 'chore'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const POINTS = [0, 1, 2, 3, 5, 8, 13, 21];
const SPRINT_STATES = ['planned', 'active', 'closed'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class BoardsError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new BoardsError(status, message); };
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const viewKeyFor = editKey => hash(editKey + ':view');

// ---------- sanitising ----------
const text = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const bool = v => v === true;
const date = v => (typeof v === 'string' && DATE_RE.test(v) ? v : '');
const iso = v => (typeof v === 'string' && v.length <= 40 && !isNaN(Date.parse(v)) ? v : null);
const num = (v, min, max, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
const id = v => { if (typeof v !== 'string' || !ID_RE.test(v)) fail(400, 'Invalid id in board data.'); return v; };
const optId = v => (v == null || v === '' ? null : id(v));
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

function cleanColumns(v) {
  const cols = list(v, 12).map(c => ({ id: id(c?.id), name: text(c?.name, 30).trim() || 'Untitled', wip: c?.wip == null || c.wip === '' ? null : num(c.wip, 1, 99, null) }));
  if (cols.length < 2) fail(400, 'A board needs at least two columns.');
  if (new Set(cols.map(c => c.id)).size !== cols.length) fail(400, 'Duplicate column ids.');
  cols[cols.length - 1].wip = null;
  return cols;
}
const notes = v => list(v, 100).map(n => ({ id: id(n?.id), text: text(n?.text, 300), done: bool(n?.done) }));
const CLEAN = {
  cards: c => ({
    id: id(c?.id), title: text(c.title, 160), desc: text(c.desc, 4000),
    type: TYPES.includes(c.type) ? c.type : 'task', priority: PRIORITIES.includes(c.priority) ? c.priority : 'medium',
    points: POINTS.includes(c.points) ? c.points : '', assignee: text(c.assignee, 60), due: date(c.due),
    labels: [...new Set(list(c.labels, 12).map(l => text(l, 40).trim()).filter(Boolean))],
    checklist: list(c.checklist, 50).map(x => ({ id: id(x?.id), text: text(x?.text, 200), done: bool(x?.done) })),
    blocked: bool(c.blocked), blockedReason: text(c.blockedReason, 200), sprint: optId(c.sprint), archived: bool(c.archived),
    order: num(c.order, -1, 1e6, 0), created: iso(c.created) || new Date().toISOString(),
    history: list(c.history, 200).map(h => ({ column: id(h?.column), at: iso(h?.at) || new Date().toISOString() })),
    doneAt: iso(c.doneAt), column: id(c.column),
  }),
  sprints: s => ({
    id: id(s?.id), name: text(s.name, 60), goal: text(s.goal, 500), start: date(s.start), end: date(s.end),
    state: SPRINT_STATES.includes(s.state) ? s.state : 'planned', capacity: s.capacity == null || s.capacity === '' ? null : num(s.capacity, 0, 999, null),
    committed: num(s.committed, 0, 1e5, 0), completed: num(s.completed, 0, 1e5, 0), startedAt: iso(s.startedAt), closedAt: iso(s.closedAt),
    retro: { good: notes(s.retro?.good), improve: notes(s.retro?.improve), actions: notes(s.retro?.actions) },
  }),
  standups: s => ({
    id: id(s?.id), date: date(s.date), sprint: optId(s.sprint),
    yesterday: text(s.yesterday, 1000), today: text(s.today, 1000), blockers: text(s.blockers, 1000),
  }),
};
const CLEAN_FIELD = {
  name: v => text(v, 60).trim() || 'Untitled project',
  sprintDays: v => num(v, 1, 60, 14),
  columns: cleanColumns,
};

function cleanDoc(d) {
  if (!d || typeof d !== 'object') fail(400, 'Missing board data.');
  if (!['scrum', 'kanban'].includes(d.type)) fail(400, 'A board must be Scrum or Kanban.');
  const doc = { type: d.type, createdAt: iso(d.createdAt) || new Date().toISOString() };
  for (const f of FIELDS) doc[f] = CLEAN_FIELD[f](d[f]);
  for (const c of COLLECTIONS) {
    const items = list(d[c], LIMITS[c]).map(CLEAN[c]);
    doc[c] = [...new Map(items.map(x => [x.id, x])).values()];
  }
  return doc;
}

function applyOps(doc, ops) {
  if (!ops || typeof ops !== 'object') fail(400, 'Missing changes.');
  const next = { ...doc };
  for (const [f, v] of Object.entries(ops.set || {})) {
    if (!FIELDS.includes(f)) fail(400, `Field ${f} cannot be changed.`);
    next[f] = CLEAN_FIELD[f](v);
  }
  for (const c of COLLECTIONS) {
    const upserts = list(ops.upsert?.[c], LIMITS[c]).map(CLEAN[c]);
    const removes = new Set(list(ops.remove?.[c], LIMITS[c]).filter(x => typeof x === 'string'));
    if (!upserts.length && !removes.size) continue;
    const map = new Map(next[c].map(x => [x.id, x]));
    for (const r of removes) map.delete(r);
    for (const u of upserts) map.set(u.id, u);
    if (map.size > LIMITS[c]) fail(413, `A board can hold at most ${LIMITS[c]} ${c}.`);
    next[c] = [...map.values()];
  }
  return next;
}

// ---------- requests ----------
function access(project, key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  const h = hash(key);
  if (h === project.edit_hash) return 'edit';
  if (h === project.view_hash) return 'view';
  return null;
}
function payload(p, role) { return { id: p.id, rev: p.rev, role, updated_at: p.updated_at, doc: p.doc }; }
function checkSize(doc) { if (Buffer.byteLength(JSON.stringify(doc)) > LIMITS.docBytes) fail(413, 'This board is too large to share. Archive or delete some cards first.'); }

function handleBoards(store, { method, mode, projectId, since, key, body, ip, rateLimit }) {
  const all = store.data.boards;

  if (mode === 'create') {
    if (method !== 'POST') fail(405, 'Use POST to share a board.');
    if (!KEY_RE.test(key || '')) fail(400, 'A private edit key is required.');
    rateLimit(ip);
    if (Object.keys(all).length >= MAX_PROJECTS) fail(507, 'The server has reached its shared board limit.');
    const doc = cleanDoc(body.doc);
    checkSize(doc);
    const now = new Date().toISOString(), pid = crypto.randomUUID();
    all[pid] = { id: pid, edit_hash: hash(key), view_hash: hash(viewKeyFor(key)), rev: 1, doc, created_at: now, updated_at: now };
    store.save();
    return payload(all[pid], 'edit');
  }

  const project = typeof projectId === 'string' && all[projectId];
  const role = project ? access(project, key) : null;
  if (!project || !role) fail(404, 'This shared board does not exist, or the link is not valid.');

  if (mode === 'get') {
    if (method !== 'GET') fail(405, 'Use GET.');
    const s = Number(since);
    if (Number.isInteger(s) && s === project.rev) return { id: project.id, rev: project.rev, role, unchanged: true };
    return payload(project, role);
  }
  if (method !== 'POST') fail(405, 'Use POST.');
  if (role !== 'edit') fail(403, 'This link is view-only.');

  if (mode === 'patch') {
    const doc = applyOps(project.doc, body.ops);
    checkSize(doc);
    project.doc = doc; project.rev++; project.updated_at = new Date().toISOString();
    store.save();
    return payload(project, role);
  }
  if (mode === 'delete') {
    delete all[project.id];
    store.save();
    return { deleted: true };
  }
  fail(400, 'Unknown request.');
}

module.exports = { handleBoards, BoardsError, cleanDoc, applyOps, viewKeyFor, LIMITS };
