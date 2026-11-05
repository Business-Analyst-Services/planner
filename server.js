'use strict';
// Daycraft server: serves the static planner and the "My Group" API at /api/circle.
// Zero dependencies. Data is persisted to a single JSON file (DATA_FILE).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CAPACITY = Number(process.env.CIRCLE_CAPACITY) || 10;
const TIMELINE_WEEKS = 13;
const MAX_BODY = 16 * 1024;
const STATUSES = ['notyet', 'done', 'partial', 'rescheduled', 'paused', 'skipped'];
const LOG_STATUSES = ['done', 'partial', 'rescheduled', 'paused', 'skipped'];

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

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- dates ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const utc = s => new Date(s + 'T12:00:00Z');
const fmt = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
const validDate = s => typeof s === 'string' && DATE_RE.test(s) && !isNaN(utc(s)) && fmt(utc(s)) === s;
const mondayOf = s => addDays(s, -((utc(s).getUTCDay() + 6) % 7));
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function inWeek(date, week) { return validDate(date) && date >= week && date <= addDays(week, 6); }

// ---------- store ----------
function emptyStore() { return { members: [], entries: {}, logs: [], comments: [] }; }

function createStore(file) {
  let data = emptyStore();
  if (file && fs.existsSync(file)) {
    try { data = { ...emptyStore(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch (e) { throw new Error(`Could not read data file ${file}: ${e.message}`); }
  }
  return {
    data,
    save() {
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    },
  };
}

// ---------- helpers ----------
const hashKey = key => crypto.createHash('sha256').update(key).digest('hex');
const entryKey = (slot, week) => slot + '@' + week;

function str(v, max, field, { required = false, min = 0 } = {}) {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : null;
  if (s === null) throw new HttpError(400, `${field} must be text.`);
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s && s.length < min) throw new HttpError(400, `${field} must be at least ${min} characters.`);
  if (s.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  return s;
}
function int(v, min, max, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} must be a whole number from ${min} to ${max}.`);
  return n;
}
function timezone(v) {
  const tz = str(v, 64, 'Timezone', { required: true });
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new HttpError(400, 'Choose a valid timezone, such as Australia/Adelaide.'); }
  return tz;
}
function time(v, required) {
  const t = typeof v === 'string' ? v : '';
  if (!t && !required) return '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new HttpError(400, 'Choose a valid time.');
  return t;
}
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function id(v) { if (typeof v !== 'string' || !ID_RE.test(v)) throw new HttpError(400, 'Invalid id.'); return v; }

// ---------- summaries ----------
function weekLogs(d, slot, week) { return d.logs.filter(l => l.slot === slot && l.week === week && !l.deleted); }

function summarize(d, slot, week) {
  const entry = d.entries[entryKey(slot, week)];
  const logs = weekLogs(d, slot, week);
  const goal = entry ? entry.goal || 1 : 1;
  const completed = logs.filter(l => l.status === 'done').length;
  let status = 'notyet';
  if (entry) {
    if (completed >= goal) status = 'done';
    else if (logs.length) status = [...logs].sort((a, b) => (a.date + a.created_at).localeCompare(b.date + b.created_at)).at(-1).status;
    else status = entry.status || 'notyet';
  }
  return { entry, logs, summary: { completed, goal, status, checkins: logs.length } };
}

function timelineWeeks(week) { return Array.from({ length: TIMELINE_WEEKS }, (_, i) => addDays(week, (i - TIMELINE_WEEKS + 1) * 7)); }

function memberTimeline(d, slot, week, current) {
  return timelineWeeks(week).map(w => {
    const { entry, summary } = summarize(d, slot, w);
    const status = w > current ? 'future' : !entry ? 'unscheduled' : summary.completed >= summary.goal ? 'done' : summary.completed > 0 ? 'partial' : 'notyet';
    return { week: w, completed: summary.completed, goal: summary.goal, status, checkins: summary.checkins };
  });
}

// Consecutive weeks ending at `week`; the in-progress current week never breaks a streak.
function streak(weekOk, week, current, joinedWeek) {
  let n = 0;
  for (let w = week; w >= joinedWeek; w = addDays(w, -7)) {
    if (weekOk(w)) n++;
    else if (w === current) continue;
    else break;
  }
  return n;
}

function publicEntry(e) {
  return { slot: e.slot, week: e.week, action: e.action, minimum: e.minimum, goal: e.goal, status: e.status,
    reflection: e.share_reflection ? e.reflection || null : null, updated_at: e.updated_at };
}
function publicLog(l) {
  return { slot: l.slot, id: l.id, date: l.date, status: l.status,
    reflection: l.share_reflection && l.reflection ? l.reflection : null, created_at: l.created_at };
}
function ownLog(l) {
  return { slot: l.slot, id: l.id, date: l.date, status: l.status, reflection: l.reflection || '',
    share_reflection: l.share_reflection ? 1 : 0, deleted: l.deleted ? 1 : 0, created_at: l.created_at };
}

function board(d, week) {
  const current = mondayOf(localToday());
  const names = new Map(d.members.map(m => [m.slot, m.name]));
  const members = [...d.members].sort((a, b) => a.slot - b.slot).map(m => {
    const { entry, logs, summary } = summarize(d, m.slot, week);
    const joinedWeek = mondayOf(m.joined_at.slice(0, 10));
    const ok = w => { const s = summarize(d, m.slot, w).summary; return !!d.entries[entryKey(m.slot, w)] && s.completed >= s.goal; };
    const checked = w => summarize(d, m.slot, w).summary.checkins > 0;
    return {
      slot: m.slot, name: m.name, joined_at: m.joined_at, summary,
      actionStreak: streak(ok, week, current, joinedWeek),
      checkinStreak: streak(checked, week, current, joinedWeek),
      timeline: memberTimeline(d, m.slot, week, current),
      entry: entry ? publicEntry(entry) : null,
      logs: logs.sort((a, b) => (a.date + a.created_at).localeCompare(b.date + b.created_at)).map(publicLog),
      comments: d.comments.filter(c => c.week === week && c.target_slot === m.slot && !c.deleted)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(c => ({ id: c.id, author_slot: c.author_slot, target_slot: c.target_slot, body: c.body, created_at: c.created_at, author_name: names.get(c.author_slot) || 'Former member' })),
    };
  });
  const teamWeek = w => {
    let total = 0, checked = 0, completed = 0;
    for (const m of d.members) {
      if (!d.entries[entryKey(m.slot, w)]) continue;
      const s = summarize(d, m.slot, w).summary;
      total++; if (s.checkins) checked++; if (s.completed >= s.goal) completed++;
    }
    const status = w > current ? 'future' : !total ? 'unscheduled' : completed === total ? 'done' : checked ? 'partial' : 'notyet';
    return { week: w, total, checked, completed, status };
  };
  const firstWeek = d.members.length ? mondayOf(d.members.map(m => m.joined_at.slice(0, 10)).sort()[0]) : week;
  const t = teamWeek(week);
  return {
    capacity: CAPACITY, count: d.members.length, week,
    team: { ...t,
      checkinStreak: streak(w => teamWeek(w).checked > 0, week, current, firstWeek),
      actionStreak: streak(w => { const x = teamWeek(w); return x.total > 0 && x.completed === x.total; }, week, current, firstWeek),
      timeline: timelineWeeks(week).map(teamWeek) },
    members,
  };
}

// ---------- API ----------
const claimAttempts = new Map();
function rateLimit(ip, limit = 20, windowMs = 60 * 60 * 1000) {
  const now = Date.now(), list = (claimAttempts.get(ip) || []).filter(t => now - t < windowMs);
  if (list.length >= limit) throw new HttpError(429, 'Too many attempts. Please try again later.');
  list.push(now); claimAttempts.set(ip, list);
}

function handleApi(store, { method, mode, week, key, body, ip }) {
  const d = store.data;
  if (!validDate(week) || mondayOf(week) !== week) throw new HttpError(400, 'Choose a valid week (a Monday).');

  if (mode === 'board') {
    if (method !== 'GET') throw new HttpError(405, 'Use GET for the board.');
    return board(d, week);
  }

  const validKey = typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
  if (mode === 'claim') {
    if (method !== 'POST') throw new HttpError(405, 'Use POST to claim a spot.');
    if (!validKey) throw new HttpError(400, 'A private editing key is required.');
    const hash = hashKey(key);
    const existing = d.members.find(m => m.key_hash === hash);
    if (existing) return { member: { slot: existing.slot, name: existing.name } };
    rateLimit(ip);
    const name = str(body.name, 40, 'Display name', { required: true, min: 2 });
    if (body.consent !== true) throw new HttpError(400, 'Please confirm you understand the board is public.');
    if (d.members.length >= CAPACITY) throw new HttpError(409, 'The pilot is full. You can still follow along.');
    const used = new Set(d.members.map(m => m.slot));
    let slot = 1; while (used.has(slot)) slot++;
    const member = { slot, name, key_hash: hash, joined_at: new Date().toISOString() };
    d.members.push(member); store.save();
    return { member: { slot, name } };
  }

  const member = validKey ? d.members.find(m => m.key_hash === hashKey(key)) : null;
  if (!member) throw new HttpError(401, 'Open your private editing link to check in.');
  const ek = entryKey(member.slot, week);

  if (mode === 'me') {
    if (method !== 'GET') throw new HttpError(405, 'Use GET.');
    const entry = d.entries[ek] || null;
    return {
      member: { slot: member.slot, name: member.name },
      entry: entry && { ...entry, share_reflection: entry.share_reflection ? 1 : 0 },
      logs: d.logs.filter(l => l.slot === member.slot && l.week === week)
        .sort((a, b) => (a.date + a.created_at).localeCompare(b.date + b.created_at)).map(ownLog),
    };
  }
  if (method !== 'POST') throw new HttpError(405, 'Use POST.');
  const now = new Date().toISOString();

  if (mode === 'save') {
    const existing = d.entries[ek];
    if (body.createOnly && existing) throw new HttpError(409, 'That week already has a commitment. Review it instead.');
    const day = typeof body.day === 'string' && body.day ? body.day : '';
    if (day && !inWeek(day, week)) throw new HttpError(400, 'The scheduled day must be within this week.');
    const status = STATUSES.includes(body.status) ? body.status : 'notyet';
    d.entries[ek] = {
      slot: member.slot, week,
      action: str(body.action, 140, 'Action', { required: true }),
      minimum: str(body.minimum, 140, 'Minimum'),
      goal: int(body.goal ?? 1, 1, 21, 'Weekly goal'),
      status,
      reflection: str(body.reflection, 1000, 'Reflection'),
      share_reflection: !!body.shareReflection,
      day, time: day ? time(body.time, true) : '',
      duration: int(body.duration ?? 30, 5, 480, 'Minutes'),
      timezone: body.timezone ? timezone(body.timezone) : existing?.timezone || 'UTC',
      created_at: existing?.created_at || now, updated_at: now,
    };
    store.save();
    return { entry: d.entries[ek] };
  }

  if (mode === 'schedule') {
    const entry = d.entries[ek];
    if (!entry) throw new HttpError(409, 'Save a commitment for this week before scheduling a time.');
    if (!inWeek(body.day, week)) throw new HttpError(400, 'Choose a day within this week.');
    Object.assign(entry, { day: body.day, time: time(body.time, true), duration: int(body.duration, 5, 480, 'Minutes'), timezone: timezone(body.timezone), updated_at: now });
    store.save();
    return { entry };
  }

  if (mode === 'log') {
    const logId = id(body.id);
    const existing = d.logs.find(l => l.id === logId);
    if (existing && existing.slot !== member.slot) throw new HttpError(403, 'That check-in belongs to someone else.');
    if (body.action === 'remove' || body.action === 'restore') {
      if (!existing) throw new HttpError(404, 'Check-in not found.');
      existing.deleted = body.action === 'remove'; existing.updated_at = now; store.save();
      return { log: ownLog(existing) };
    }
    if (!d.entries[ek]) throw new HttpError(409, 'Save a commitment for this week before checking in.');
    if (!inWeek(body.date, week)) throw new HttpError(400, 'Choose a check-in date within this week.');
    if (!LOG_STATUSES.includes(body.status)) throw new HttpError(400, 'Choose a check-in outcome.');
    const fields = { date: body.date, status: body.status, reflection: str(body.reflection, 1000, 'Reflection'), share_reflection: !!body.shareReflection, updated_at: now };
    if (existing) {
      if (existing.week !== week) throw new HttpError(400, 'That check-in belongs to another week.');
      Object.assign(existing, fields);
    } else {
      if (weekLogs(d, member.slot, week).length >= 100) throw new HttpError(429, 'That is a lot of check-ins for one week.');
      d.logs.push({ id: logId, slot: member.slot, week, deleted: false, created_at: now, ...fields });
    }
    store.save();
    return { log: ownLog(existing || d.logs.at(-1)) };
  }

  if (mode === 'comment') {
    const commentId = id(body.id);
    const existing = d.comments.find(c => c.id === commentId);
    if (body.action === 'remove' || body.action === 'restore') {
      if (!existing) throw new HttpError(404, 'Comment not found.');
      if (existing.author_slot !== member.slot) throw new HttpError(403, 'You can only change your own comments.');
      existing.deleted = body.action === 'remove'; store.save();
      return { ok: true };
    }
    if (existing) {
      if (existing.author_slot !== member.slot) throw new HttpError(409, 'Comment id already used.');
      return { ok: true }; // idempotent retry
    }
    if (body.consent !== true) throw new HttpError(400, 'Please confirm comments are public.');
    const target = Number(body.targetSlot);
    if (!d.members.some(m => m.slot === target) || !d.entries[entryKey(target, week)]) throw new HttpError(404, 'That commitment is not available to comment on.');
    const text = str(body.text, 1000, 'Comment', { required: true });
    if (d.comments.filter(c => c.author_slot === member.slot && c.week === week).length >= 200) throw new HttpError(429, 'Comment limit reached for this week.');
    d.comments.push({ id: commentId, week, author_slot: member.slot, target_slot: target, body: text, created_at: now, deleted: false });
    store.save();
    return { ok: true };
  }

  throw new HttpError(400, 'Unknown request.');
}

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
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
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

function createApp({ dataFile = process.env.DATA_FILE || path.join(__dirname, 'data', 'circle.json') } = {}) {
  const store = createStore(dataFile);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/circle') return serveStatic(req, res, url.pathname);
    try {
      let body = {};
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request body.');
      }
      const auth = req.headers.authorization || '';
      const result = handleApi(store, {
        method: req.method, mode: url.searchParams.get('mode') || 'board', week: url.searchParams.get('week'),
        key: auth.startsWith('Bearer ') ? auth.slice(7).trim() : '', body,
        ip: req.socket.remoteAddress || '',
      });
      sendJson(res, 200, result);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      sendJson(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong. Try again.' });
    }
  });
  return { server, store };
}

module.exports = { createApp, handleApi, board, mondayOf, addDays };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().server.listen(port, () => console.log(`Daycraft running at http://localhost:${port}`));
}
