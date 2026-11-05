'use strict';
// My Group API logic (/api/circle). Works on a plain data object; callers load and save it.

const crypto = require('node:crypto');

const CAPACITY = Number(process.env.CIRCLE_CAPACITY) || 10;
const TIMELINE_LENGTH = 13;
const STATUSES = ['notyet', 'done', 'partial', 'rescheduled', 'paused', 'skipped'];
const LOG_STATUSES = ['done', 'partial', 'rescheduled', 'paused', 'skipped'];

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
// ---------- periods ----------
// A commitment covers one period. Weekly records keep their original key (the Monday), so
// existing data is unchanged; other periods are keyed "<period>:<start date>".
const PERIODS = {
  week: { label: 'week', goalMax: 21 },
  fortnight: { label: 'fortnight', goalMax: 42 },
  month: { label: 'month', goalMax: 62 },
  quarter: { label: 'quarter', goalMax: 186 },
};
const FORTNIGHT_ANCHOR = '2024-01-01'; // a Monday; fortnights start every 14 days from here
const addMonths = (s, n) => { const d = utc(s.slice(0, 8) + '01'); d.setUTCMonth(d.getUTCMonth() + n); return fmt(d); };
function periodStart(period, date) {
  if (period === 'week') return mondayOf(date);
  if (period === 'fortnight') { const m = mondayOf(date), weeks = Math.round((utc(m) - utc(FORTNIGHT_ANCHOR)) / 864e5 / 7); return addDays(m, -(((weeks % 2) + 2) % 2) * 7); }
  if (period === 'month') return date.slice(0, 8) + '01';
  const month = Number(date.slice(5, 7)); return date.slice(0, 5) + String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0') + '-01';
}
function shiftPeriod(period, start, n) {
  return period === 'week' ? addDays(start, 7 * n) : period === 'fortnight' ? addDays(start, 14 * n) : addMonths(start, (period === 'quarter' ? 3 : 1) * n);
}
const periodEnd = (period, start) => addDays(shiftPeriod(period, start, 1), -1);
const pkeyOf = (period, start) => (period === 'week' ? start : period + ':' + start);
function inPeriod(date, period, start) { return validDate(date) && date >= start && date <= periodEnd(period, start); }

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

function timelineStarts(period, start) { return Array.from({ length: TIMELINE_LENGTH }, (_, i) => shiftPeriod(period, start, i - TIMELINE_LENGTH + 1)); }

function memberTimeline(d, slot, period, start, current) {
  return timelineStarts(period, start).map(s => {
    const { entry, summary } = summarize(d, slot, pkeyOf(period, s));
    const status = s > current ? 'future' : !entry ? 'unscheduled' : summary.completed >= summary.goal ? 'done' : summary.completed > 0 ? 'partial' : 'notyet';
    return { week: s, completed: summary.completed, goal: summary.goal, status, checkins: summary.checkins };
  });
}

// Consecutive periods ending at `start`; the in-progress current period never breaks a streak.
function streak(ok, period, start, current, firstStart) {
  let n = 0;
  for (let s = start; s >= firstStart; s = shiftPeriod(period, s, -1)) {
    if (ok(pkeyOf(period, s))) n++;
    else if (s === current) continue;
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

function board(d, period, start) {
  const week = pkeyOf(period, start), current = periodStart(period, localToday());
  const names = new Map(d.members.map(m => [m.slot, m.name]));
  const members = [...d.members].sort((a, b) => a.slot - b.slot).map(m => {
    const { entry, logs, summary } = summarize(d, m.slot, week);
    const joined = periodStart(period, m.joined_at.slice(0, 10));
    const ok = w => { const s = summarize(d, m.slot, w).summary; return !!d.entries[entryKey(m.slot, w)] && s.completed >= s.goal; };
    const checked = w => summarize(d, m.slot, w).summary.checkins > 0;
    return {
      slot: m.slot, name: m.name, joined_at: m.joined_at, summary,
      actionStreak: streak(ok, period, start, current, joined),
      checkinStreak: streak(checked, period, start, current, joined),
      timeline: memberTimeline(d, m.slot, period, start, current),
      entry: entry ? publicEntry(entry) : null,
      logs: logs.sort((a, b) => (a.date + a.created_at).localeCompare(b.date + b.created_at)).map(publicLog),
      comments: d.comments.filter(c => c.week === week && c.target_slot === m.slot && !c.deleted)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(c => ({ id: c.id, author_slot: c.author_slot, target_slot: c.target_slot, body: c.body, created_at: c.created_at, author_name: names.get(c.author_slot) || 'Former member' })),
    };
  });
  const teamWeek = s => {
    const w = pkeyOf(period, s);
    let total = 0, checked = 0, completed = 0;
    for (const m of d.members) {
      if (!d.entries[entryKey(m.slot, w)]) continue;
      const s = summarize(d, m.slot, w).summary;
      total++; if (s.checkins) checked++; if (s.completed >= s.goal) completed++;
    }
    const status = s > current ? 'future' : !total ? 'unscheduled' : completed === total ? 'done' : checked ? 'partial' : 'notyet';
    return { week: s, total, checked, completed, status };
  };
  const first = d.members.length ? periodStart(period, d.members.map(m => m.joined_at.slice(0, 10)).sort()[0]) : start;
  const startOf = k => (k.includes(':') ? k.split(':')[1] : k);
  const t = teamWeek(start);
  return {
    capacity: CAPACITY, count: d.members.length, week: start, period, start, end: periodEnd(period, start),
    team: { ...t,
      checkinStreak: streak(k => teamWeek(startOf(k)).checked > 0, period, start, current, first),
      actionStreak: streak(k => { const x = teamWeek(startOf(k)); return x.total > 0 && x.completed === x.total; }, period, start, current, first),
      timeline: timelineStarts(period, start).map(teamWeek) },
    members,
  };
}

// ---------- API ----------
const attempts = new Map();
function rateLimit(ip, bucket = 'claim', limit = 20, windowMs = 60 * 60 * 1000) {
  const k = bucket + ':' + ip, now = Date.now(), list = (attempts.get(k) || []).filter(t => now - t < windowMs);
  if (list.length >= limit) throw new HttpError(429, 'Too many attempts. Please try again later.');
  list.push(now); attempts.set(k, list);
}

function handleApi(store, { method, mode, week: start, period = 'week', key, body, ip }) {
  const d = store.data;
  if (!PERIODS[period]) throw new HttpError(400, 'Choose week, fortnight, month or quarter.');
  const P = PERIODS[period].label;
  if (!validDate(start) || periodStart(period, start) !== start) throw new HttpError(400, `Choose a valid start date for this ${P}.`);
  const week = pkeyOf(period, start);
  const inWeek = date => inPeriod(date, period, start);

  if (mode === 'board') {
    if (method !== 'GET') throw new HttpError(405, 'Use GET for the board.');
    return board(d, period, start);
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
      member: { slot: member.slot, name: member.name }, period, start, end: periodEnd(period, start),
      entry: entry && { ...entry, week: start, share_reflection: entry.share_reflection ? 1 : 0 },
      logs: d.logs.filter(l => l.slot === member.slot && l.week === week)
        .sort((a, b) => (a.date + a.created_at).localeCompare(b.date + b.created_at)).map(ownLog),
    };
  }
  if (method !== 'POST') throw new HttpError(405, 'Use POST.');
  const now = new Date().toISOString();

  if (mode === 'save') {
    const existing = d.entries[ek];
    if (body.createOnly && existing) throw new HttpError(409, `That ${P} already has a commitment. Review it instead.`);
    const day = typeof body.day === 'string' && body.day ? body.day : '';
    if (day && !inWeek(day)) throw new HttpError(400, `The scheduled day must be within this ${P}.`);
    const status = STATUSES.includes(body.status) ? body.status : 'notyet';
    d.entries[ek] = {
      slot: member.slot, week, period, start,
      action: str(body.action, 140, 'Action', { required: true }),
      minimum: str(body.minimum, 140, 'Minimum'),
      goal: int(body.goal ?? 1, 1, PERIODS[period].goalMax, 'Goal'),
      status,
      reflection: str(body.reflection, 1000, 'Reflection'),
      share_reflection: !!body.shareReflection,
      day, time: day ? time(body.time, true) : '',
      duration: int(body.duration ?? 30, 5, 480, 'Minutes'),
      timezone: body.timezone ? timezone(body.timezone) : existing?.timezone || 'UTC',
      created_at: existing?.created_at || now, updated_at: now,
    };
    store.save();
    return { entry: { ...d.entries[ek], week: start } };
  }

  if (mode === 'schedule') {
    const entry = d.entries[ek];
    if (!entry) throw new HttpError(409, `Save a commitment for this ${P} before scheduling a time.`);
    if (!inWeek(body.day)) throw new HttpError(400, `Choose a day within this ${P}.`);
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
    if (!d.entries[ek]) throw new HttpError(409, `Save a commitment for this ${P} before checking in.`);
    if (!inWeek(body.date)) throw new HttpError(400, `Choose a check-in date within this ${P}.`);
    if (!LOG_STATUSES.includes(body.status)) throw new HttpError(400, 'Choose a check-in outcome.');
    const fields = { date: body.date, status: body.status, reflection: str(body.reflection, 1000, 'Reflection'), share_reflection: !!body.shareReflection, updated_at: now };
    if (existing) {
      if (existing.week !== week) throw new HttpError(400, `That check-in belongs to another ${P}.`);
      Object.assign(existing, fields);
    } else {
      if (weekLogs(d, member.slot, week).length >= 400) throw new HttpError(429, `That is a lot of check-ins for one ${P}.`);
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
    if (d.comments.filter(c => c.author_slot === member.slot && c.week === week).length >= 200) throw new HttpError(429, `Comment limit reached for this ${P}.`);
    d.comments.push({ id: commentId, week, author_slot: member.slot, target_slot: target, body: text, created_at: now, deleted: false });
    store.save();
    return { ok: true };
  }

  throw new HttpError(400, 'Unknown request.');
}

const emptyCircle = () => ({ members: [], entries: {}, logs: [], comments: [] });

module.exports = { handleApi, board, mondayOf, addDays, periodStart, periodEnd, shiftPeriod, PERIODS, rateLimit, HttpError, emptyCircle };
