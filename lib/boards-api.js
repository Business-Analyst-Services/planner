'use strict';
// Shared Boards API: /api/boards
//
// A shared project is a JSON document (columns, cards, sprints, stand-ups) stored on the server.
// People join as named members (owner, editor or viewer). Each member has a personal secret link
// (a 64-hex key generated in the browser); an optional public view-only link can be switched on.
// Any link can be reset ("rotated") so the old one stops working. Only SHA-256 hashes of keys are stored.
//
// Clients send changes as entity-level patches (upsert/remove cards, sprints and stand-ups by id,
// set top-level fields). Patches apply to the latest revision, so two people editing different
// cards never overwrite each other; edits to the same card resolve last-writer-wins.

const crypto = require('node:crypto');

const LIMITS = { cards: 3000, sprints: 300, standups: 2000, docBytes: Number(process.env.BOARDS_MAX_BYTES) || 1000000 };
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
    updatedBy: text(c.updatedBy, 40), updatedAt: iso(c.updatedAt),
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

// ---------- members & links ----------
const ROLES = ['owner', 'editor', 'viewer'];
const CAN_EDIT = { owner: true, editor: true };
const SEEN_EVERY = 5 * 60 * 1000;
const MAX_MEMBERS = 50;
const ACTIVITY = 200;

const memberName = v => {
  const name = text(v, 40).trim();
  if (name.length < 1) fail(400, 'Enter a name.');
  return name;
};
function newKeyHash(project, key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) fail(400, 'A new private key is required.');
  const h = hash(key);
  if (project && (project.members.some(m => m.key_hash === h) || project.view_hash === h)) fail(409, 'Key already in use.');
  return h;
}

// Older shared boards (single edit/view link) become an owner member plus a public view link.
function migrate(p) {
  if (!p.members) {
    p.members = p.edit_hash ? [{ id: crypto.randomUUID(), name: 'Owner', role: 'owner', key_hash: p.edit_hash, created_at: p.created_at, last_seen: null }] : [];
    delete p.edit_hash;
    p.view_link_at = p.view_hash ? p.created_at : null;
  }
  p.activity = p.activity || [];
  return p;
}

function access(p, key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  const h = hash(key);
  const me = p.members.find(m => m.key_hash === h);
  if (me) return { role: me.role, me };
  if (p.view_hash && h === p.view_hash) return { role: 'public', me: null };
  return null;
}

const publicMember = m => ({ id: m.id, name: m.name, role: m.role, created_at: m.created_at, last_seen: m.last_seen, link_reset_at: m.link_reset_at || null });
function payload(p, a, { includeDoc = true } = {}) {
  const out = { id: p.id, rev: p.rev, role: a.role, updated_at: p.updated_at };
  if (a.me) {
    out.me = publicMember(a.me);
    out.members = p.members.map(publicMember);
    out.activity = p.activity.slice(-50).reverse();
    if (a.role === 'owner') out.viewLink = { enabled: !!p.view_hash, created_at: p.view_link_at || null };
  }
  if (includeDoc) out.doc = p.doc;
  return out;
}
function log(p, me, summary) {
  p.activity.push({ at: new Date().toISOString(), by: me.name, summary: text(summary, 300) });
  if (p.activity.length > ACTIVITY) p.activity.splice(0, p.activity.length - ACTIVITY);
}
function bump(p) { p.rev++; p.updated_at = new Date().toISOString(); }
function checkSize(doc) { if (Buffer.byteLength(JSON.stringify(doc)) > LIMITS.docBytes) fail(413, 'This board is too large to share. Archive or delete some cards first.'); }

// Human summary of a patch for the activity log, e.g. "updated “Fix login” · added 1 sprint".
function describe(before, ops) {
  const parts = [];
  const titles = new Map(before.cards.map(c => [c.id, c.title]));
  const up = list(ops.upsert?.cards, 1e4), rm = list(ops.remove?.cards, 1e4);
  const added = up.filter(c => !titles.has(c?.id)), changed = up.filter(c => titles.has(c?.id));
  const name = c => `“${text(c?.title, 60)}”`;
  const few = (verb, cs, f) => cs.length && parts.push(cs.length <= 2 ? `${verb} ${cs.map(f).join(', ')}` : `${verb} ${cs.length} cards`);
  few('added', added, name); few('updated', changed, name);
  few('removed', rm, cid => `“${text(titles.get(cid) || 'a card', 60)}”`);
  for (const c of ['sprints', 'standups']) {
    const n = list(ops.upsert?.[c], 1e4).length + list(ops.remove?.[c], 1e4).length;
    if (n) parts.push(`changed ${n} ${c === 'sprints' ? (n === 1 ? 'sprint' : 'sprints') : (n === 1 ? 'stand-up note' : 'stand-up notes')}`);
  }
  for (const f of Object.keys(ops.set || {})) parts.push(f === 'columns' ? 'changed the columns' : f === 'name' ? 'renamed the board' : 'changed the sprint length');
  return parts.join(' · ') || 'made a change';
}

function handleBoards(store, { method, mode, projectId, newId, since, key, body, ip, rateLimit }) {
  const all = store.data.boards;

  if (mode === 'create') {
    if (method !== 'POST') fail(405, 'Use POST to share a board.');
    rateLimit(ip);
    const keyHash = newKeyHash(null, key);
    const doc = cleanDoc(body.doc);
    checkSize(doc);
    const now = new Date().toISOString(), pid = newId || crypto.randomUUID();
    const owner = { id: crypto.randomUUID(), name: memberName(body.name), role: 'owner', key_hash: keyHash, created_at: now, last_seen: now };
    all[pid] = { id: pid, members: [owner], view_hash: null, view_link_at: null, rev: 1, doc, activity: [], created_at: now, updated_at: now };
    log(all[pid], owner, 'shared the board');
    store.save();
    return payload(all[pid], { role: 'owner', me: owner });
  }

  const project = typeof projectId === 'string' && all[projectId] ? migrate(all[projectId]) : null;
  const a = project ? access(project, key) : null;
  if (!project || !a) fail(404, 'This shared board does not exist, or your link is no longer valid.');
  const { me } = a;
  const owner = a.role === 'owner';
  const now = new Date().toISOString();
  if (me && (!me.last_seen || Date.now() - Date.parse(me.last_seen) > SEEN_EVERY)) { me.last_seen = now; store.save(); }

  if (mode === 'get') {
    if (method !== 'GET') fail(405, 'Use GET.');
    const s = Number(since);
    if (Number.isInteger(s) && s === project.rev) return { id: project.id, rev: project.rev, role: a.role, unchanged: true };
    return payload(project, a);
  }
  if (method !== 'POST') fail(405, 'Use POST.');

  if (mode === 'patch') {
    if (!CAN_EDIT[a.role]) fail(403, 'You can view this board but not change it.');
    const ops = body.ops || {};
    for (const c of list(ops.upsert?.cards, LIMITS.cards)) if (c && typeof c === 'object') { c.updatedBy = me.name; c.updatedAt = now; }
    const doc = applyOps(project.doc, ops);
    checkSize(doc);
    log(project, me, describe(project.doc, ops));
    project.doc = doc; bump(project);
    store.save();
    return payload(project, a);
  }

  if (mode === 'rotate') {
    // Owners can reset anyone's link; everyone can reset their own.
    if (!me) fail(403, 'Public view links cannot reset links.');
    const target = project.members.find(m => m.id === (body.memberId || me.id));
    if (!target) fail(404, 'Member not found.');
    if (target !== me && !owner) fail(403, 'Only owners can reset other people’s links.');
    target.key_hash = newKeyHash(project, body.key); target.link_reset_at = now;
    log(project, me, target === me ? 'reset their own link' : `reset ${target.name}’s link`);
    bump(project); store.save();
    return payload(project, target === me ? { role: me.role, me } : a, { includeDoc: false });
  }

  if (mode === 'leave') {
    if (!me) fail(403, 'Public view links are not members.');
    if (owner && project.members.filter(m => m.role === 'owner').length === 1 && project.members.length > 1) fail(409, 'Make someone else an owner before you leave.');
    project.members = project.members.filter(m => m !== me);
    if (!project.members.length) { delete all[project.id]; store.save(); return { left: true, deleted: true }; }
    log(project, me, 'left the board'); bump(project); store.save();
    return { left: true };
  }

  if (!owner) fail(403, 'Only owners can manage members and links.');

  if (mode === 'invite') {
    if (project.members.length >= MAX_MEMBERS) fail(409, `A board can have at most ${MAX_MEMBERS} members.`);
    const name = memberName(body.name);
    if (project.members.some(m => m.name.toLowerCase() === name.toLowerCase())) fail(409, `${name} is already a member.`);
    const role = ROLES.includes(body.role) ? body.role : 'editor';
    const member = { id: crypto.randomUUID(), name, role, key_hash: newKeyHash(project, body.key), created_at: now, last_seen: null };
    project.members.push(member);
    log(project, me, `invited ${name} as ${role}`); bump(project); store.save();
    return { ...payload(project, a, { includeDoc: false }), member: publicMember(member) };
  }

  if (mode === 'member') {
    const target = project.members.find(m => m.id === body.memberId);
    if (!target) fail(404, 'Member not found.');
    const owners = project.members.filter(m => m.role === 'owner');
    const losesOwner = target.role === 'owner' && owners.length === 1 && (body.remove || (body.role && body.role !== 'owner'));
    if (losesOwner) fail(409, 'A board needs at least one owner.');
    if (body.remove) {
      project.members = project.members.filter(m => m !== target);
      log(project, me, `removed ${target.name}`);
    } else {
      if (body.name != null) {
        const name = memberName(body.name);
        if (project.members.some(m => m !== target && m.name.toLowerCase() === name.toLowerCase())) fail(409, `${name} is already a member.`);
        if (name !== target.name) log(project, me, `renamed ${target.name} to ${name}`);
        target.name = name;
      }
      if (body.role != null) {
        if (!ROLES.includes(body.role)) fail(400, 'Choose owner, editor or viewer.');
        if (body.role !== target.role) log(project, me, `made ${target.name} ${body.role === 'owner' ? 'an owner' : 'a' + (body.role === 'editor' ? 'n editor' : ' viewer')}`);
        target.role = body.role;
      }
    }
    bump(project); store.save();
    return payload(project, a, { includeDoc: false });
  }

  if (mode === 'viewlink') {
    if (body.action === 'disable') { project.view_hash = null; project.view_link_at = null; log(project, me, 'turned off the public view link'); }
    else if (body.action === 'enable' || body.action === 'rotate') {
      project.view_hash = newKeyHash(project, body.key); project.view_link_at = now;
      log(project, me, body.action === 'rotate' ? 'reset the public view link' : 'turned on the public view link');
    } else fail(400, 'Choose enable, rotate or disable.');
    bump(project); store.save();
    return payload(project, a, { includeDoc: false });
  }

  if (mode === 'delete') {
    delete all[project.id];
    store.save();
    return { deleted: true };
  }
  fail(400, 'Unknown request.');
}

module.exports = { handleBoards, BoardsError, cleanDoc, applyOps, LIMITS, MAX_PROJECTS };
