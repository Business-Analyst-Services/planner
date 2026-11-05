// BAS Planner Boards: Scrum and Kanban projects, stored locally in this browser.
(() => {
'use strict';

const STORE_KEY = 'daycraft-boards-v1';
const UI_KEY = 'daycraft-boards-ui';
const PLANNER_KEY = 'daycraft-v1';
const DAY = 86400000;

const TYPES = { story: 'Story', task: 'Task', bug: 'Bug', spike: 'Spike', chore: 'Chore' };
const PRIORITIES = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
const POINTS = ['', 0, 1, 2, 3, 5, 8, 13, 21];
const VIEWS = {
  scrum: [['backlog', 'Backlog'], ['sprint', 'Sprint board'], ['reports', 'Reports'], ['ceremonies', 'Ceremonies']],
  kanban: [['board', 'Board'], ['metrics', 'Flow metrics']],
};

// ---------- utilities ----------
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = s => new Date(s + 'T12:00:00');
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const today = () => ymd(new Date());
const endOfDay = s => new Date(s + 'T23:59:59.999').getTime();
const pretty = s => s ? parse(s).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '';
const prettyY = s => s ? parse(s).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY);
const isoDaysAgo = n => new Date(Date.now() - n * DAY).toISOString();
const pts = c => Number(c.points) || 0;
const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
const round1 = n => Math.round(n * 10) / 10;
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');

function toast(text) {
  const t = $('#toast'); t.textContent = text; t.style.display = 'block';
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.style.display = 'none'), 4000);
}

// ---------- store ----------
let store, ui;
function load() {
  try { ui = JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { ui = {}; }
  try { store = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { store = null; }
  if (!validStore(store)) { store = { version: 1, projects: [] }; seed(); persist(); }
  store.projects.forEach(p => { p.standups = p.standups || []; p.standups.forEach(x => { if (!x.id) x.id = uid(); }); });
  if (!store.projects.some(p => p.id === ui.project)) ui.project = store.projects[0]?.id;
  ui.filters = ui.filters || {};
}
function validStore(s) {
  return s && Array.isArray(s.projects) && s.projects.every(p =>
    typeof p.id === 'string' && typeof p.name === 'string' && ['scrum', 'kanban'].includes(p.type) &&
    Array.isArray(p.columns) && p.columns.length >= 2 && Array.isArray(p.cards) && Array.isArray(p.sprints));
}
function save() {
  guardReadonly();
  persist();
  queueSyncAll();
}
function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { toast('Storage unavailable. Export your boards to keep a backup.'); }
  saveUi();
}
function saveUi() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch {} }

const project = () => store.projects.find(p => p.id === ui.project);
const doneColumn = p => p.columns[p.columns.length - 1];
const isDone = (p, c) => c.column === doneColumn(p).id;
const activeSprint = p => p.sprints.find(s => s.state === 'active');
const sprintById = (p, id) => p.sprints.find(s => s.id === id);

function newCard(p, fields = {}) {
  const column = fields.column || p.columns[0].id;
  const now = new Date().toISOString();
  return {
    id: uid(), title: '', desc: '', type: 'story', priority: 'medium', points: '', assignee: '', labels: [], due: '',
    checklist: [], blocked: false, blockedReason: '', sprint: null, archived: false,
    order: p.cards.length, created: now, history: [{ column, at: now }], doneAt: null, ...fields, column,
  };
}

// Move a card into a column (and optionally before another card), recording flow history.
function moveCard(p, card, columnId, beforeId = null) {
  if (card.column !== columnId) {
    card.column = columnId;
    card.history.push({ column: columnId, at: new Date().toISOString() });
    card.doneAt = isDone(p, card) ? new Date().toISOString() : null;
  }
  const siblings = p.cards.filter(c => c !== card && c.column === columnId).sort((a, b) => a.order - b.order);
  const idx = beforeId ? siblings.findIndex(c => c.id === beforeId) : -1;
  siblings.splice(idx < 0 ? siblings.length : idx, 0, card);
  siblings.forEach((c, i) => (c.order = i));
}

function wipWarning(p, columnId) {
  const col = p.columns.find(c => c.id === columnId);
  if (!col?.wip) return;
  const count = boardCards(p).filter(c => c.column === columnId).length;
  if (count > col.wip) toast(`WIP limit exceeded in “${col.name}” (${count}/${col.wip}). Finish something before starting more.`);
}

// ---------- seed data ----------
function seed() {
  const t = today();
  const cols = names => names.map(([name, wip]) => ({ id: uid(), name, wip: wip || null }));

  // Scrum example
  const s = { id: uid(), name: 'Website relaunch', type: 'scrum', sprintDays: 14, columns: cols([['To do'], ['In progress', 3], ['Review', 2], ['Done']]), cards: [], sprints: [], standups: [], createdAt: isoDaysAgo(20) };
  const [todo, doing, review, done] = s.columns.map(c => c.id);
  const sp0 = { id: uid(), name: 'Sprint 1', goal: 'Agree the new information architecture', start: addDays(t, -17), end: addDays(t, -4), state: 'closed', capacity: 20, committed: 18, completed: 15, closedAt: isoDaysAgo(4), retro: { good: [{ id: uid(), text: 'Quick feedback from stakeholders' }], improve: [{ id: uid(), text: 'Stories were too big to finish in a day or two' }], actions: [{ id: uid(), text: 'Split stories over 5 points during refinement', done: false }] } };
  const sp1 = { id: uid(), name: 'Sprint 2', goal: 'Launch the new home page to a beta audience', start: addDays(t, -3), end: addDays(t, 10), state: 'active', capacity: 20, committed: 21, completed: 0, retro: { good: [], improve: [], actions: [] } };
  const sp2 = { id: uid(), name: 'Sprint 3', goal: '', start: addDays(t, 11), end: addDays(t, 24), state: 'planned', capacity: 20, committed: 0, completed: 0, retro: { good: [], improve: [], actions: [] } };
  s.sprints.push(sp0, sp1, sp2);
  const sc = (title, col, extra = {}, doneDaysAgo = null) => {
    const c = newCard(s, { title, column: col, created: isoDaysAgo(12), ...extra });
    c.history = [{ column: todo, at: isoDaysAgo(12) }];
    if (col !== todo) c.history.push({ column: col, at: isoDaysAgo(doneDaysAgo ?? 2) });
    if (col === done) c.doneAt = isoDaysAgo(doneDaysAgo ?? 1);
    c.order = s.cards.filter(x => x.column === col).length;
    s.cards.push(c);
  };
  sc('Hero section with new brand imagery', done, { sprint: sp1.id, points: 5, type: 'story', assignee: 'Alex', labels: ['frontend'] }, 2);
  sc('Navigation works on mobile', done, { sprint: sp1.id, points: 3, type: 'story', assignee: 'Sam', labels: ['frontend', 'mobile'] }, 1);
  sc('Newsletter signup form', review, { sprint: sp1.id, points: 3, type: 'story', assignee: 'Alex', checklist: [{ id: uid(), text: 'Validates email', done: true }, { id: uid(), text: 'Shows success message', done: false }] });
  sc('Page speed under 2 seconds', doing, { sprint: sp1.id, points: 5, type: 'task', assignee: 'Priya', labels: ['performance'] });
  sc('Broken link in footer', doing, { sprint: sp1.id, points: 1, type: 'bug', priority: 'high', assignee: 'Sam' });
  sc('Analytics consent banner', todo, { sprint: sp1.id, points: 3, type: 'story', priority: 'high', labels: ['legal'], due: addDays(t, 6) });
  sc('Investigate CMS image resizing', todo, { sprint: sp1.id, points: 1, type: 'spike', blocked: true, blockedReason: 'Waiting on CMS vendor' });
  sc('Agree sitemap', done, { sprint: sp0.id, points: 5, assignee: 'Priya' }, 6);
  sc('Blog listing page', todo, { sprint: sp2.id, points: 5, type: 'story', labels: ['frontend'] });
  sc('Search results page', todo, { points: 8, type: 'story', priority: 'medium' });
  sc('Accessibility audit fixes', todo, { points: 5, type: 'task', priority: 'high', labels: ['a11y'] });
  sc('Dark mode', todo, { points: 3, type: 'story', priority: 'low' });
  s.cards.forEach((c, i) => { if (c.sprint === null && c.column === todo) c.order = i; });

  // Kanban example
  const k = { id: uid(), name: 'Team requests', type: 'kanban', sprintDays: 14, columns: cols([['Backlog'], ['Ready', 5], ['Doing', 3], ['Review', 2], ['Done']]), cards: [], sprints: [], standups: [], createdAt: isoDaysAgo(30) };
  const [kb, kr, kd, kv, kdone] = k.columns.map(c => c.id);
  const kc = (title, steps, extra = {}) => {
    const c = newCard(k, { title, ...extra });
    c.created = isoDaysAgo(steps[0][1]);
    c.history = steps.map(([col, ago]) => ({ column: col, at: isoDaysAgo(ago) }));
    c.column = steps.at(-1)[0];
    if (c.column === kdone) c.doneAt = isoDaysAgo(steps.at(-1)[1]);
    c.order = k.cards.filter(x => x.column === c.column).length;
    k.cards.push(c);
  };
  const people = ['Alex', 'Sam', 'Priya', 'Jo'];
  const kinds = ['task', 'bug', 'chore', 'task', 'story'];
  for (let i = 0; i < 14; i++) {
    const start = 28 - i * 2;
    kc(['Update onboarding doc', 'Fix export bug', 'Renew SSL certificate', 'Quarterly report data', 'New starter laptop', 'Clean up old branches', 'Customer CSV import', 'Price page typo', 'Slack integration', 'Backup restore test', 'Holiday roster', 'Invoice template', 'Survey results summary', 'Archive old projects'][i],
      [[kb, start], [kr, start - 1], [kd, start - 2], [kv, start - 3 - (i % 3)], [kdone, Math.max(0, start - 4 - (i % 4))]],
      { assignee: people[i % 4], type: kinds[i % 5], points: [1, 2, 3, 5][i % 4] });
  }
  kc('Office move checklist', [[kb, 8], [kr, 6], [kd, 5]], { assignee: 'Jo', type: 'task', priority: 'high' });
  kc('Login timeout complaints', [[kb, 4], [kr, 3], [kd, 2]], { assignee: 'Sam', type: 'bug', priority: 'urgent', blocked: true, blockedReason: 'Need logs from IT' });
  kc('Team offsite agenda', [[kb, 5], [kr, 3], [kd, 1], [kv, 0]], { assignee: 'Priya', type: 'task' });
  kc('Refresh brand templates', [[kb, 6], [kr, 2]], { type: 'chore' });
  kc('Evaluate new CRM', [[kb, 3]], { type: 'spike', priority: 'low' });
  kc('Accessibility training', [[kb, 1]], { type: 'task' });
  store.projects.push(s, k);
}

// ---------- filtering ----------
function matches(c) {
  const f = ui.filters, q = (f.q || '').toLowerCase();
  if (q && !(c.title + ' ' + c.desc + ' ' + c.labels.join(' ') + ' ' + c.assignee).toLowerCase().includes(q)) return false;
  if (f.type && c.type !== f.type) return false;
  if (f.assignee && (c.assignee || '__none') !== f.assignee) return false;
  if (f.label && !c.labels.includes(f.label)) return false;
  return true;
}
function boardCards(p) {
  if (p.type === 'scrum') { const s = activeSprint(p); return s ? p.cards.filter(c => c.sprint === s.id) : []; }
  return p.cards.filter(c => !c.archived);
}

// ---------- shared rendering ----------
function cardMarkup(p, c, { compact = false, showMove = true } = {}) {
  const t = today(), checklistDone = c.checklist.filter(x => x.done).length;
  const overdue = c.due && c.due < t && !isDone(p, c);
  const enteredAt = [...c.history].reverse().find(h => h.column === c.column)?.at;
  const age = enteredAt ? Math.floor((Date.now() - new Date(enteredAt)) / DAY) : 0;
  const colIdx = p.columns.findIndex(col => col.id === c.column);
  const showAge = p.type === 'kanban' && !isDone(p, c) && colIdx > 0;
  return `<article class="card type-${esc(c.type)} prio-${esc(c.priority)} ${c.blocked ? 'is-blocked' : ''} ${isDone(p, c) ? 'is-done' : ''}" draggable="true" data-card="${esc(c.id)}" tabindex="0" aria-label="${esc(c.title)}. ${esc(TYPES[c.type])}, ${esc(PRIORITIES[c.priority])} priority${c.points !== '' ? ', ' + c.points + ' points' : ''}${c.blocked ? ', blocked' : ''}. Press Enter to edit.">
    <div class="card-top"><span class="type-tag">${esc(TYPES[c.type] || c.type)}</span>${c.priority === 'urgent' || c.priority === 'high' ? `<span class="prio-tag">${esc(PRIORITIES[c.priority])}</span>` : ''}${c.blocked ? `<span class="blocked-tag" title="${esc(c.blockedReason)}">⛔ Blocked</span>` : ''}</div>
    <div class="card-title">${esc(c.title)}</div>
    ${!compact && c.labels.length ? `<div class="labels">${c.labels.map(l => `<span class="label">${esc(l)}</span>`).join('')}</div>` : ''}
    <div class="card-meta">
      ${c.points !== '' ? `<span class="points" title="Story points">${esc(c.points)}</span>` : ''}
      ${c.checklist.length ? `<span title="Checklist">☑ ${checklistDone}/${c.checklist.length}</span>` : ''}
      ${c.due ? `<span class="${overdue ? 'overdue' : ''}" title="Due ${esc(prettyY(c.due))}">📅 ${esc(pretty(c.due))}</span>` : ''}
      ${showAge ? `<span class="age ${age >= 5 ? 'old' : ''}" title="Days in this column">${age}d</span>` : ''}
      <span class="spacer"></span>
      ${c.assignee ? `<span class="avatar" title="${esc(c.assignee)}">${esc(initials(c.assignee))}</span>` : ''}
    </div>
    ${showMove ? `<div class="card-move"><button type="button" data-move="-1" aria-label="Move ${esc(c.title)} to previous column" ${colIdx <= 0 ? 'disabled' : ''}>‹</button><button type="button" data-move="1" aria-label="Move ${esc(c.title)} to next column" ${colIdx >= p.columns.length - 1 ? 'disabled' : ''}>›</button></div>` : ''}
  </article>`;
}

let dragId = null;
function bindCards(root, p) {
  root.querySelectorAll('[data-card]').forEach(el => {
    const card = p.cards.find(c => c.id === el.dataset.card);
    el.ondragstart = e => { if (e.target.closest('button')) { e.preventDefault(); return; } dragId = card.id; e.dataTransfer.setData('text/plain', card.id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); };
    el.ondragend = () => { dragId = null; el.classList.remove('dragging'); $$('.over').forEach(x => x.classList.remove('over')); };
    el.onclick = e => { if (!e.target.closest('button')) openCard(card.id); };
    el.onkeydown = e => { if (e.key === 'Enter' && e.target === el) openCard(card.id); };
    el.querySelectorAll('[data-move]').forEach(b => b.onclick = () => {
      const idx = p.columns.findIndex(c => c.id === card.column) + Number(b.dataset.move);
      if (idx < 0 || idx >= p.columns.length) return;
      moveCard(p, card, p.columns[idx].id); save(); render(); wipWarning(p, p.columns[idx].id);
      document.querySelector(`[data-card="${card.id}"]`)?.focus();
    });
  });
}
function dropZone(el, onDrop) {
  el.addEventListener('dragover', e => { if (!dragId) return; e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); });
  el.addEventListener('drop', e => {
    if (!dragId) return;
    e.preventDefault(); e.stopPropagation(); el.classList.remove('over');
    const before = e.target.closest('[data-card]');
    const id = dragId; dragId = null;
    onDrop(id, before && before.dataset.card !== id ? before.dataset.card : null);
  });
}

const LANES = {
  assignee: { label: 'Assignee', key: c => c.assignee || '', name: v => v || 'Unassigned', set: (c, v) => (c.assignee = v) },
  priority: { label: 'Priority', key: c => c.priority, name: v => PRIORITIES[v], set: (c, v) => (c.priority = v), order: Object.keys(PRIORITIES) },
  type: { label: 'Type', key: c => c.type, name: v => TYPES[v], set: (c, v) => (c.type = v), order: Object.keys(TYPES) },
};

function boardMarkup(p, cards) {
  const laneDef = LANES[ui.filters.lanes];
  let lanes = [null];
  if (laneDef) {
    const keys = [...new Set(cards.map(laneDef.key))];
    lanes = laneDef.order ? laneDef.order.filter(k => keys.includes(k)) : keys.sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
    if (!lanes.length) lanes = [laneDef.order ? laneDef.order[0] : ''];
  }
  const allInBoard = boardCards(p);
  const head = p.columns.map((col, i) => {
    const n = allInBoard.filter(c => c.column === col.id).length;
    const over = col.wip && n > col.wip, at = col.wip && n === col.wip;
    const colPts = sum(allInBoard.filter(c => c.column === col.id), pts);
    return `<div class="col-head ${over ? 'wip-over' : at ? 'wip-at' : ''}"><strong>${esc(col.name)}</strong>${i === p.columns.length - 1 ? ' <span class="done-mark" title="Done column">✓</span>' : ''}<span class="count" title="${col.wip ? 'Cards / WIP limit' : 'Cards'}">${n}${col.wip ? ' / ' + col.wip : ''}</span>${colPts ? `<span class="col-points" title="Story points">${colPts} pts</span>` : ''}</div>`;
  }).join('');
  const body = lanes.map(lane => {
    const laneCards = laneDef ? cards.filter(c => laneDef.key(c) === lane) : cards;
    return (laneDef ? `<div class="lane-head" style="grid-column:1/-1">${esc(laneDef.label)}: <strong>${esc(laneDef.name(lane))}</strong> <span class="muted">${laneCards.length}</span></div>` : '') +
      p.columns.map(col => {
        const list = laneCards.filter(c => c.column === col.id).sort((a, b) => a.order - b.order);
        return `<div class="col-cell" data-col="${esc(col.id)}" ${laneDef ? `data-lane="${esc(lane)}"` : ''} aria-label="${esc(col.name)}">${list.map(c => cardMarkup(p, c)).join('')}${!list.length ? '<div class="col-empty">Drop cards here</div>' : ''}</div>`;
      }).join('');
  }).join('');
  return `<div class="board" style="--cols:${p.columns.length}"><div class="board-grid">${head}${body}</div></div>`;
}

function bindBoard(root, p, { sprintId = null } = {}) {
  bindCards(root, p);
  root.querySelectorAll('.col-cell').forEach(cell => dropZone(cell, (id, before) => {
    const card = p.cards.find(c => c.id === id);
    if (cell.dataset.lane !== undefined && LANES[ui.filters.lanes]) LANES[ui.filters.lanes].set(card, cell.dataset.lane);
    if (sprintId) card.sprint = sprintId;
    moveCard(p, card, cell.dataset.col, before); save(); render(); wipWarning(p, cell.dataset.col);
  }));
}

// ---------- Scrum: backlog & sprint planning ----------
function velocity(p) {
  const closed = p.sprints.filter(s => s.state === 'closed').sort((a, b) => a.end.localeCompare(b.end)).slice(-3);
  return closed.length ? round1(sum(closed, s => s.completed) / closed.length) : null;
}

function backlogRow(p, c) {
  return `<div class="backlog-row ${isDone(p, c) ? 'is-done' : ''} ${c.blocked ? 'is-blocked' : ''}" draggable="true" data-card="${esc(c.id)}" tabindex="0" aria-label="${esc(c.title)}. Press Enter to edit.">
    <span class="type-dot type-${esc(c.type)}" title="${esc(TYPES[c.type])}"></span>
    <span class="row-title">${esc(c.title)}${c.blocked ? ' <span class="blocked-tag">⛔</span>' : ''}</span>
    <span class="row-labels">${c.labels.map(l => `<span class="label">${esc(l)}</span>`).join('')}</span>
    <span class="row-status">${esc(p.columns.find(col => col.id === c.column)?.name || '')}</span>
    <span class="prio-pill prio-${esc(c.priority)}">${esc(PRIORITIES[c.priority])}</span>
    ${c.assignee ? `<span class="avatar" title="${esc(c.assignee)}">${esc(initials(c.assignee))}</span>` : '<span class="avatar empty" title="Unassigned"></span>'}
    <span class="points ${c.points === '' ? 'unestimated' : ''}" title="Story points">${c.points === '' ? '–' : esc(c.points)}</span>
  </div>`;
}

function renderBacklog(p) {
  const v = velocity(p);
  const sprints = p.sprints.filter(s => s.state !== 'closed').sort((a, b) => (a.state === 'active' ? -1 : b.state === 'active' ? 1 : a.start.localeCompare(b.start)));
  const backlog = p.cards.filter(c => c.sprint === null && !isDone(p, c) && matches(c)).sort((a, b) => a.order - b.order);
  const allBacklog = p.cards.filter(c => c.sprint === null && !isDone(p, c));
  const unestimated = allBacklog.filter(c => c.points === '').length;
  const section = s => {
    const cards = p.cards.filter(c => c.sprint === s.id).sort((a, b) => a.order - b.order);
    const total = sum(cards, pts), doneP = sum(cards.filter(c => isDone(p, c)), pts);
    const cap = s.capacity || v;
    const overCap = cap && total > cap;
    const days = daysBetween(today(), s.end);
    return `<section class="sprint-section ${s.state}" data-sprint="${esc(s.id)}">
      <div class="sprint-head">
        <div><h3>${esc(s.name)} ${s.state === 'active' ? '<span class="state-pill active">Active</span>' : '<span class="state-pill">Planned</span>'}</h3>
        <div class="muted small">${esc(prettyY(s.start))} – ${esc(prettyY(s.end))}${s.state === 'active' ? ` · ${days >= 0 ? days + ' days left' : 'ended ' + -days + ' days ago'}` : ''}</div>
        ${s.goal ? `<p class="sprint-goal">🎯 ${esc(s.goal)}</p>` : ''}</div>
        <div class="sprint-tools">
          <span class="capacity ${overCap ? 'over' : ''}" title="${s.capacity ? 'Committed points vs capacity' : v ? 'Committed points vs average velocity' : 'Committed points'}">${total}${cap ? ' / ' + cap : ''} pts${s.state === 'active' ? ` · ${doneP} done` : ''}</span>
          <button data-edit-sprint="${esc(s.id)}">Edit</button>
          ${s.state === 'planned' ? `<button class="primary" data-start-sprint="${esc(s.id)}" ${activeSprint(p) ? 'disabled title="Complete the active sprint first"' : ''}>Start sprint</button>` : `<button class="primary" data-close-sprint="${esc(s.id)}">Complete sprint</button>`}
        </div>
      </div>
      ${overCap ? `<p class="warn small">Committed points exceed ${s.capacity ? 'capacity' : 'average velocity'} by ${round1(total - cap)}. Consider moving something back to the backlog.</p>` : ''}
      <div class="row-list" data-drop-sprint="${esc(s.id)}">${cards.filter(matches).map(c => backlogRow(p, c)).join('') || '<div class="col-empty">Drag backlog items here to plan them into this sprint.</div>'}</div>
    </section>`;
  };
  $('#view').innerHTML = `<div class="backlog-layout">
    <div class="backlog-main">
      ${sprints.map(section).join('')}
      <section class="sprint-section backlog" data-sprint="">
        <div class="sprint-head"><div><h3>Product backlog</h3><div class="muted small">${allBacklog.length} items · ${sum(allBacklog, pts)} pts${unestimated ? ` · ${unestimated} unestimated` : ''} · ordered by priority to the team</div></div>
        <div class="sprint-tools"><button id="createsprint">＋ Create sprint</button></div></div>
        <div class="row-list" data-drop-sprint="">${backlog.map(c => backlogRow(p, c)).join('') || '<div class="col-empty">The backlog is empty. Add your first item below.</div>'}</div>
        <form class="quick-add" id="quickadd"><input name="title" maxlength="160" placeholder="＋ Add a backlog item and press Enter" aria-label="New backlog item title"><select name="points" aria-label="Story points">${POINTS.map(x => `<option value="${x}">${x === '' ? 'Points' : x}</option>`).join('')}</select><button class="primary">Add</button></form>
      </section>
    </div>
    <aside class="side-panel">
      <div class="eyebrow">SPRINT PLANNING</div>
      <div class="stat-grid">
        <div class="stat"><b>${v ?? '–'}</b><span>Average velocity<br><small>last 3 sprints</small></span></div>
        <div class="stat"><b>${sum(allBacklog, pts)}</b><span>Points in<br>backlog</span></div>
        <div class="stat"><b>${v ? Math.ceil(sum(allBacklog, pts) / v) : '–'}</b><span>Sprints to clear<br><small>at current velocity</small></span></div>
        <div class="stat"><b>${unestimated}</b><span>Items needing<br>estimates</span></div>
      </div>
      <div class="tip">Drag to prioritise the backlog: the top item is the most important.<br>Drag items into a sprint to commit to them, then <strong>Start sprint</strong>.<br>Only one sprint can be active at a time.</div>
    </aside>
  </div>`;
  bindCards($('#view'), p);
  $$('[data-drop-sprint]').forEach(list => dropZone(list, (id, before) => {
    const card = p.cards.find(c => c.id === id), target = list.dataset.dropSprint || null;
    card.sprint = target;
    const siblings = p.cards.filter(c => c !== card && c.sprint === target && (target || !isDone(p, c))).sort((a, b) => a.order - b.order);
    const idx = before ? siblings.findIndex(c => c.id === before) : -1;
    siblings.splice(idx < 0 ? siblings.length : idx, 0, card);
    siblings.forEach((c, i) => (c.order = i));
    save(); render();
  }));
  $('#createsprint').onclick = () => openSprint();
  $$('[data-edit-sprint]').forEach(b => b.onclick = () => openSprint(b.dataset.editSprint));
  $$('[data-start-sprint]').forEach(b => b.onclick = () => startSprint(b.dataset.startSprint));
  $$('[data-close-sprint]').forEach(b => b.onclick = () => openClose(b.dataset.closeSprint));
  $('#quickadd').onsubmit = e => {
    e.preventDefault();
    const f = e.target.elements, title = f.title.value.trim();
    if (!title) return;
    const c = newCard(p, { title, points: f.points.value === '' ? '' : Number(f.points.value) });
    c.order = allBacklog.length; p.cards.push(c); save(); render();
    $('#quickadd input').focus();
  };
}

function startSprint(id) {
  const p = project(), s = sprintById(p, id);
  if (activeSprint(p)) return toast('Complete the active sprint before starting another.');
  const cards = p.cards.filter(c => c.sprint === s.id);
  if (!cards.length && !confirm('This sprint has no items. Start it anyway?')) return;
  s.state = 'active'; s.committed = sum(cards, pts); s.startedAt = new Date().toISOString();
  if (s.start > today()) { const len = daysBetween(s.start, s.end); s.start = today(); s.end = addDays(s.start, len); }
  ui.view = 'sprint'; save(); render();
  toast(`${s.name} started with ${s.committed} committed points.`);
}

function openSprint(id = null) {
  const p = project(), s = id ? sprintById(p, id) : null, f = $('#sprintform').elements;
  const last = [...p.sprints].sort((a, b) => a.end.localeCompare(b.end)).at(-1);
  const start = s ? s.start : last && last.end >= today() ? addDays(last.end, 1) : today();
  f.name.value = s ? s.name : 'Sprint ' + (p.sprints.length + 1);
  f.goal.value = s ? s.goal : '';
  f.start.value = start;
  f.end.value = s ? s.end : addDays(start, (p.sprintDays || 14) - 1);
  f.capacity.value = s?.capacity ?? '';
  const v = velocity(p);
  $('#sprinthint').textContent = v ? `Average velocity over recent sprints: ${v} points.` : 'Velocity appears here after your first completed sprint.';
  $('#sprintheading').textContent = s ? 'Edit sprint' : 'New sprint';
  $('#deletesprint').hidden = !s || s.state !== 'planned';
  $('#sprintform').dataset.id = id || '';
  $('#sprintdialog').showModal();
}
$('#sprintform').onsubmit = e => {
  e.preventDefault();
  const p = project(), f = e.target.elements, id = e.target.dataset.id;
  if (f.end.value < f.start.value) return toast('The sprint must end after it starts.');
  const fields = { name: f.name.value.trim(), goal: f.goal.value.trim(), start: f.start.value, end: f.end.value, capacity: f.capacity.value === '' ? null : Number(f.capacity.value) };
  if (id) Object.assign(sprintById(p, id), fields);
  else p.sprints.push({ id: uid(), state: 'planned', committed: 0, completed: 0, retro: { good: [], improve: [], actions: [] }, ...fields });
  save(); $('#sprintdialog').close(); render();
};
$('#cancelsprint').onclick = () => $('#sprintdialog').close();
$('#deletesprint').onclick = () => {
  const p = project(), id = $('#sprintform').dataset.id;
  if (!confirm('Delete this sprint? Its items return to the product backlog.')) return;
  p.cards.forEach(c => { if (c.sprint === id) c.sprint = null; });
  p.sprints = p.sprints.filter(s => s.id !== id);
  save(); $('#sprintdialog').close(); render();
};

function openClose(id) {
  const p = project(), s = sprintById(p, id);
  const cards = p.cards.filter(c => c.sprint === s.id), done = cards.filter(c => isDone(p, c)), open = cards.filter(c => !isDone(p, c));
  $('#closeheading').textContent = 'Complete ' + s.name;
  $('#closesummary').innerHTML = `<div class="stat-grid"><div class="stat"><b>${done.length}</b><span>Completed<br>items</span></div><div class="stat"><b>${sum(done, pts)}</b><span>Points<br>delivered</span></div><div class="stat"><b>${open.length}</b><span>Unfinished<br>items</span></div><div class="stat"><b>${s.committed || 0}</b><span>Points<br>committed</span></div></div>${s.goal ? `<p>Sprint goal: <strong>${esc(s.goal)}</strong></p>` : ''}`;
  const sel = $('#closeform').elements.target;
  sel.innerHTML = '<option value="">Product backlog</option>' + p.sprints.filter(x => x.state === 'planned').map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('') + '<option value="__new">A new sprint</option>';
  sel.closest('label').hidden = !open.length;
  $('#closeform').dataset.id = id;
  $('#closedialog').showModal();
}
$('#closeform').onsubmit = e => {
  e.preventDefault();
  const p = project(), s = sprintById(p, e.target.dataset.id);
  let target = e.target.elements.target.value || null;
  const cards = p.cards.filter(c => c.sprint === s.id);
  if (target === '__new') {
    const start = addDays(s.end < today() ? today() : s.end, 1);
    const ns = { id: uid(), name: 'Sprint ' + (p.sprints.length + 1), goal: '', start, end: addDays(start, (p.sprintDays || 14) - 1), state: 'planned', capacity: s.capacity, committed: 0, completed: 0, retro: { good: [], improve: [], actions: [] } };
    p.sprints.push(ns); target = ns.id;
  }
  s.completed = sum(cards.filter(c => isDone(p, c)), pts);
  s.state = 'closed'; s.closedAt = new Date().toISOString();
  cards.filter(c => !isDone(p, c)).forEach(c => (c.sprint = target));
  save(); $('#closedialog').close();
  ui.view = 'ceremonies'; ui.retroSprint = s.id; render();
  toast(`${s.name} completed: ${s.completed} points delivered. Time for a retrospective.`);
};
$('#cancelclose').onclick = () => $('#closedialog').close();

// ---------- Scrum: sprint board ----------
function renderSprintBoard(p) {
  const s = activeSprint(p);
  if (!s) {
    const planned = p.sprints.filter(x => x.state === 'planned');
    $('#view').innerHTML = `<div class="empty-state"><h2>No active sprint</h2><p>Plan a sprint from the backlog, then start it to see the sprint board.</p><button class="primary" id="gobacklog">Go to backlog${planned.length ? ` · ${planned.length} planned sprint${planned.length > 1 ? 's' : ''}` : ''}</button></div>`;
    $('#gobacklog').onclick = () => { ui.view = 'backlog'; render(); };
    return;
  }
  const cards = p.cards.filter(c => c.sprint === s.id);
  const total = sum(cards, pts), doneP = sum(cards.filter(c => isDone(p, c)), pts);
  const length = daysBetween(s.start, s.end) + 1, elapsed = Math.min(length, Math.max(0, daysBetween(s.start, today()) + 1));
  $('#view').innerHTML = `<section class="sprint-banner">
      <div><div class="eyebrow">ACTIVE SPRINT · DAY ${elapsed} OF ${length}</div><h2>${esc(s.name)}</h2>${s.goal ? `<p class="sprint-goal">🎯 ${esc(s.goal)}</p>` : ''}<div class="muted small">${esc(prettyY(s.start))} – ${esc(prettyY(s.end))}</div></div>
      <div class="banner-progress"><div class="muted small">${doneP} of ${total} points done · ${cards.filter(c => isDone(p, c)).length}/${cards.length} items</div><div class="bar"><i style="width:${total ? (doneP / total) * 100 : 0}%"></i><b style="left:${(elapsed / length) * 100}%" title="Time elapsed"></b></div>
      <div class="banner-actions"><button id="sprintreports">Burndown</button><button class="primary" id="completesprint">Complete sprint</button></div></div>
    </section>${boardMarkup(p, cards.filter(matches))}`;
  bindBoard($('#view'), p, { sprintId: s.id });
  $('#completesprint').onclick = () => openClose(s.id);
  $('#sprintreports').onclick = () => { ui.view = 'reports'; ui.reportSprint = s.id; render(); };
}

// ---------- charts ----------
function lineChart({ series, labels, yMax, height = 220, yLabel = '' }) {
  const W = 640, H = height, L = 40, R = 12, T = 12, B = 30, w = W - L - R, h = H - T - B;
  const n = labels.length, x = i => L + (n <= 1 ? w / 2 : (i / (n - 1)) * w), y = v => T + h - (v / (yMax || 1)) * h;
  const ticks = niceTicks(yMax);
  const step = Math.ceil(n / 8);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(series.map(s => s.name).join(' and '))} chart">
    ${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 4}" class="tick" text-anchor="end">${t}</text>`).join('')}
    ${labels.map((l, i) => i % step === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 8}" class="tick" text-anchor="middle">${esc(l)}</text>` : '').join('')}
    ${yLabel ? `<text x="12" y="${T + h / 2}" class="tick" transform="rotate(-90 12 ${T + h / 2})" text-anchor="middle">${esc(yLabel)}</text>` : ''}
    ${series.map(s => { const pts = s.values.map((v, i) => v == null ? null : `${x(i)},${y(v)}`).filter(Boolean); return `<polyline points="${pts.join(' ')}" class="line ${s.cls}" fill="none"/>${s.dots ? s.values.map((v, i) => v == null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="3" class="dot ${s.cls}"><title>${esc(labels[i])}: ${v}</title></circle>`).join('') : ''}`; }).join('')}
  </svg>`;
}
function niceTicks(max) {
  if (!max) return [0];
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw);
  const out = []; for (let v = 0; v <= max + 1e-9; v += step) out.push(round1(v)); return out;
}
function legend(items) { return `<div class="legend">${items.map(([cls, name]) => `<span><i class="sw ${cls}"></i>${esc(name)}</span>`).join('')}</div>`; }

function burndownData(p, s) {
  const cards = p.cards.filter(c => c.sprint === s.id);
  let total = sum(cards, pts), unit = 'points', val = pts;
  if (!total) { total = cards.length; unit = 'items'; val = () => 1; }
  const days = daysBetween(s.start, s.end) + 1, t = today();
  const labels = [], ideal = [], actual = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(s.start, i);
    labels.push(pretty(d));
    ideal.push(round1(total - (total * i) / Math.max(1, days - 1)));
    actual.push(d > t ? null : total - sum(cards.filter(c => c.doneAt && new Date(c.doneAt).getTime() <= endOfDay(d) && isDone(p, c)), val));
  }
  return { labels, ideal, actual, total, unit };
}

// ---------- Scrum: reports ----------
function renderReports(p) {
  const options = p.sprints.filter(s => s.state !== 'planned').sort((a, b) => b.start.localeCompare(a.start));
  if (!options.some(s => s.id === ui.reportSprint)) ui.reportSprint = (activeSprint(p) || options[0])?.id;
  const s = sprintById(p, ui.reportSprint);
  const closed = p.sprints.filter(x => x.state === 'closed').sort((a, b) => a.end.localeCompare(b.end));
  const v = velocity(p);
  let burn = '<p class="muted">Start a sprint to see its burndown.</p>';
  if (s) {
    const b = burndownData(p, s), remaining = b.actual.filter(x => x != null).at(-1);
    burn = `<div class="chart-head"><label>Sprint <select id="reportsprint">${options.map(x => `<option value="${esc(x.id)}" ${x.id === s.id ? 'selected' : ''}>${esc(x.name)}${x.state === 'active' ? ' (active)' : ''}</option>`).join('')}</select></label>
      <span class="muted small">${remaining ?? b.total} of ${b.total} ${b.unit} remaining</span></div>
      ${lineChart({ series: [{ name: 'Ideal', values: b.ideal, cls: 'ideal' }, { name: 'Remaining', values: b.actual, cls: 'actual', dots: true }], labels: b.labels, yMax: b.total, yLabel: b.unit })}
      ${legend([['ideal', 'Ideal burndown'], ['actual', 'Remaining work']])}
      <p class="muted small">Remaining work drops when a card reaches the Done column. ${b.unit === 'items' ? 'No cards are estimated, so the chart counts items.' : ''}</p>`;
  }
  const maxV = Math.max(1, ...closed.map(x => Math.max(x.committed || 0, x.completed || 0)));
  const vel = closed.length ? `<svg viewBox="0 0 640 220" class="chart" role="img" aria-label="Velocity chart">
      ${niceTicks(maxV).map(t => { const y = 12 + 178 - (t / maxV) * 178; return `<line x1="40" x2="628" y1="${y}" y2="${y}" class="grid"/><text x="34" y="${y + 4}" class="tick" text-anchor="end">${t}</text>`; }).join('')}
      ${closed.map((x, i) => { const bw = 588 / closed.length, bar = Math.min(48, bw * 0.33), x0 = 40 + i * bw + bw / 2 - bar - 1, hC = ((x.committed || 0) / maxV) * 178, hD = ((x.completed || 0) / maxV) * 178; return `<rect x="${x0}" y="${190 - hC}" width="${bar}" height="${hC}" class="bar-committed"><title>${esc(x.name)} committed: ${x.committed || 0}</title></rect><rect x="${x0 + bar + 2}" y="${190 - hD}" width="${bar}" height="${hD}" class="bar-completed"><title>${esc(x.name)} completed: ${x.completed || 0}</title></rect><text x="${x0 + bar}" y="208" class="tick" text-anchor="middle">${esc(x.name)}</text>`; }).join('')}
    </svg>${legend([['bar-committed', 'Committed'], ['bar-completed', 'Completed']])}` : '<p class="muted">Velocity appears after you complete your first sprint.</p>';
  $('#view').innerHTML = `<div class="report-grid">
    <section class="panel"><div class="eyebrow">BURNDOWN</div>${burn}</section>
    <section class="panel"><div class="eyebrow">VELOCITY</div><div class="stat-grid three"><div class="stat"><b>${v ?? '–'}</b><span>Average<br><small>last 3</small></span></div><div class="stat"><b>${closed.length ? Math.max(...closed.map(x => x.completed)) : '–'}</b><span>Best<br>sprint</span></div><div class="stat"><b>${closed.length ? Math.round((sum(closed, x => x.completed) / Math.max(1, sum(closed, x => x.committed))) * 100) + '%' : '–'}</b><span>Say / do<br>ratio</span></div></div>${vel}</section>
    <section class="panel wide"><div class="eyebrow">SPRINT HISTORY</div>
      <table class="table"><thead><tr><th>Sprint</th><th>Dates</th><th>Goal</th><th>Committed</th><th>Completed</th><th>Status</th></tr></thead><tbody>
      ${[...p.sprints].sort((a, b) => b.start.localeCompare(a.start)).map(x => `<tr><td>${esc(x.name)}</td><td>${esc(pretty(x.start))} – ${esc(pretty(x.end))}</td><td>${esc(x.goal || '–')}</td><td>${x.state === 'planned' ? sum(p.cards.filter(c => c.sprint === x.id), pts) + ' (planned)' : x.committed || 0}</td><td>${x.state === 'closed' ? x.completed : x.state === 'active' ? sum(p.cards.filter(c => c.sprint === x.id && isDone(p, c)), pts) + ' so far' : '–'}</td><td><span class="state-pill ${x.state}">${x.state[0].toUpperCase() + x.state.slice(1)}</span></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No sprints yet.</td></tr>'}
      </tbody></table></section>
  </div>`;
  $('#reportsprint')?.addEventListener('change', e => { ui.reportSprint = e.target.value; render(); });
}

// ---------- Scrum: ceremonies (daily scrum + retrospective) ----------
function renderCeremonies(p) {
  const s = activeSprint(p);
  p.standups = p.standups || [];
  const t = today();
  const todays = p.standups.find(x => x.date === t && x.sprint === (s?.id || null));
  const blocked = p.cards.filter(c => c.blocked && (s ? c.sprint === s.id : true) && !isDone(p, c));
  const options = p.sprints.filter(x => x.state !== 'planned').sort((a, b) => b.start.localeCompare(a.start));
  if (!options.some(x => x.id === ui.retroSprint)) ui.retroSprint = (options.find(x => x.state === 'closed') || options[0])?.id;
  const r = sprintById(p, ui.retroSprint);
  const retroCol = (key, title, hint) => `<div class="retro-col retro-${key}"><h4>${title}</h4><p class="muted small">${hint}</p>
    ${r.retro[key].map(n => `<div class="retro-note">${key === 'actions' ? `<input type="checkbox" data-retro-done="${esc(n.id)}" ${n.done ? 'checked' : ''} aria-label="Mark action done">` : ''}<span class="${n.done ? 'struck' : ''}">${esc(n.text)}</span>${key === 'actions' ? `<button class="icon" data-retro-plan="${esc(n.id)}" title="Add to planner" aria-label="Add action to planner">📅</button>` : ''}<button class="icon" data-retro-del="${key}:${esc(n.id)}" aria-label="Remove note">×</button></div>`).join('')}
    <form class="inline-add" data-retro-add="${key}"><input maxlength="300" placeholder="Add a note" aria-label="Add to ${title}"><button>Add</button></form></div>`;
  $('#view').innerHTML = `<div class="report-grid">
    <section class="panel"><div class="eyebrow">DAILY SCRUM · ${esc(prettyY(t).toUpperCase())}</div>
      ${s ? `<p class="muted small">${esc(s.name)}${s.goal ? ' · 🎯 ' + esc(s.goal) : ''}</p>` : '<p class="muted small">No active sprint. Notes are saved against the project.</p>'}
      <form id="standupform">
        <label>Yesterday<textarea name="yesterday" rows="2" maxlength="1000">${esc(todays?.yesterday || '')}</textarea></label>
        <label>Today<textarea name="today" rows="2" maxlength="1000">${esc(todays?.today || '')}</textarea></label>
        <label>Blockers / impediments<textarea name="blockers" rows="2" maxlength="1000">${esc(todays?.blockers || '')}</textarea></label>
        <div class="actions"><button class="primary">Save today’s notes</button></div>
      </form>
      ${blocked.length ? `<div class="impediments"><strong>⛔ Blocked cards</strong>${blocked.map(c => `<div><a href="#" data-open-card="${esc(c.id)}">${esc(c.title)}</a>${c.blockedReason ? ` — <span class="muted">${esc(c.blockedReason)}</span>` : ''}</div>`).join('')}</div>` : ''}
      <details class="history"><summary>Previous daily scrums (${p.standups.filter(x => x.date !== t).length})</summary>
        ${p.standups.filter(x => x.date !== t).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30).map(x => `<div class="standup-entry"><strong>${esc(prettyY(x.date))}</strong>${x.yesterday ? `<p><em>Yesterday:</em> ${esc(x.yesterday)}</p>` : ''}${x.today ? `<p><em>Today:</em> ${esc(x.today)}</p>` : ''}${x.blockers ? `<p><em>Blockers:</em> ${esc(x.blockers)}</p>` : ''}</div>`).join('') || '<p class="muted small">None yet.</p>'}
      </details>
    </section>
    <section class="panel"><div class="eyebrow">SPRINT RETROSPECTIVE</div>
      ${r ? `<label>Sprint <select id="retrosprint">${options.map(x => `<option value="${esc(x.id)}" ${x.id === r.id ? 'selected' : ''}>${esc(x.name)}${x.state === 'active' ? ' (active)' : ''}</option>`).join('')}</select></label>
      ${r.state === 'closed' ? `<p class="muted small">Delivered ${r.completed} of ${r.committed} committed points.</p>` : ''}
      <div class="retro-grid">${retroCol('good', 'Went well', 'Keep doing')}${retroCol('improve', 'To improve', 'What got in the way?')}${retroCol('actions', 'Action items', 'Small, owned, actionable')}</div>` : '<p class="muted">Retrospectives appear once a sprint has started.</p>'}
    </section>
  </div>`;
  $('#standupform').onsubmit = e => {
    e.preventDefault();
    const f = e.target.elements, entry = { id: todays?.id || uid(), date: t, sprint: s?.id || null, yesterday: f.yesterday.value.trim(), today: f.today.value.trim(), blockers: f.blockers.value.trim() };
    p.standups = p.standups.filter(x => !(x.date === t && x.sprint === entry.sprint));
    if (entry.yesterday || entry.today || entry.blockers) p.standups.push(entry);
    save(); render(); toast('Daily scrum notes saved.');
  };
  $$('[data-open-card]').forEach(a => a.onclick = e => { e.preventDefault(); openCard(a.dataset.openCard); });
  if (!r) return;
  $('#retrosprint').onchange = e => { ui.retroSprint = e.target.value; render(); };
  $$('[data-retro-add]').forEach(form => form.onsubmit = e => {
    e.preventDefault(); const text = form.querySelector('input').value.trim(); if (!text) return;
    r.retro[form.dataset.retroAdd].push({ id: uid(), text, done: false }); save(); render();
    document.querySelector(`[data-retro-add="${form.dataset.retroAdd}"] input`)?.focus();
  });
  $$('[data-retro-del]').forEach(b => b.onclick = () => { const [k, id] = b.dataset.retroDel.split(':'); r.retro[k] = r.retro[k].filter(n => n.id !== id); save(); render(); });
  $$('[data-retro-done]').forEach(b => b.onchange = () => { r.retro.actions.find(n => n.id === b.dataset.retroDone).done = b.checked; save(); render(); });
  $$('[data-retro-plan]').forEach(b => b.onclick = () => { const n = r.retro.actions.find(x => x.id === b.dataset.retroPlan); openPlan({ title: n.text, due: '' }); });
}

// ---------- Kanban ----------
function renderKanban(p) {
  const archived = p.cards.filter(c => c.archived).length;
  const doneCards = p.cards.filter(c => !c.archived && isDone(p, c));
  $('#view').innerHTML = boardMarkup(p, boardCards(p).filter(matches)) +
    `<div class="board-foot"><span class="muted small">Cards show days in their current column. Column counts turn amber at the WIP limit and red above it.</span><span class="spacer"></span>
    ${doneCards.length ? `<button id="archivedone">Archive ${doneCards.length} done card${doneCards.length > 1 ? 's' : ''}</button>` : ''}
    ${archived ? `<details class="archived"><summary>Archived (${archived})</summary>${p.cards.filter(c => c.archived).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).slice(0, 100).map(c => `<div class="archived-row"><span>${esc(c.title)}</span><span class="muted small">${c.doneAt ? 'Done ' + esc(prettyY(c.doneAt.slice(0, 10))) : ''}</span><button data-unarchive="${esc(c.id)}">Restore</button></div>`).join('')}</details>` : ''}</div>`;
  bindBoard($('#view'), p);
  $('#archivedone')?.addEventListener('click', () => { doneCards.forEach(c => (c.archived = true)); save(); render(); toast('Done cards archived. Flow metrics still include them.'); });
  $$('[data-unarchive]').forEach(b => b.onclick = () => { p.cards.find(c => c.id === b.dataset.unarchive).archived = false; save(); render(); });
}

function flowTimes(p, c) {
  if (!c.doneAt) return null;
  const startIdx = c.history.find(h => p.columns.findIndex(col => col.id === h.column) > 0);
  const done = new Date(c.doneAt).getTime();
  return { lead: (done - new Date(c.created)) / DAY, cycle: startIdx ? (done - new Date(startIdx.at)) / DAY : 0 };
}
function percentile(list, q) { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; }

function renderMetrics(p) {
  const now = Date.now(), t = today();
  const completed = p.cards.filter(c => c.doneAt && isDone(p, c));
  const inWindow = d => completed.filter(c => now - new Date(c.doneAt) <= d * DAY);
  const recent = inWindow(30).map(c => flowTimes(p, c)).filter(Boolean);
  const cycles = recent.map(x => x.cycle), leads = recent.map(x => x.lead);
  const wip = p.cards.filter(c => !c.archived && !isDone(p, c) && p.columns.findIndex(col => col.id === c.column) > 0);
  const blocked = p.cards.filter(c => c.blocked && !c.archived && !isDone(p, c));

  // Cumulative flow: cards per column at the end of each of the last 30 days.
  const days = Array.from({ length: 30 }, (_, i) => addDays(t, i - 29));
  const counts = days.map(d => {
    const end = endOfDay(d), row = Object.fromEntries(p.columns.map(c => [c.id, 0]));
    for (const c of p.cards) {
      if (new Date(c.created).getTime() > end) continue;
      const h = [...c.history].reverse().find(x => new Date(x.at).getTime() <= end);
      if (h && h.column in row) row[h.column]++;
    }
    return row;
  });
  const stackOrder = [...p.columns].reverse(); // Done at the bottom
  const maxTotal = Math.max(1, ...counts.map(r => sum(Object.values(r), x => x)));
  const W = 1280, H = 300, L = 40, R = 12, T = 12, B = 30, w = W - L - R, h = H - T - B;
  const x = i => L + (i / (days.length - 1)) * w, y = v => T + h - (v / maxTotal) * h;
  const palette = ['cfd-0', 'cfd-1', 'cfd-2', 'cfd-3', 'cfd-4', 'cfd-5', 'cfd-6', 'cfd-7'];
  let lower = days.map(() => 0);
  const areas = stackOrder.map((col, ci) => {
    const upper = lower.map((v, i) => v + counts[i][col.id]);
    const path = 'M' + upper.map((v, i) => `${x(i)},${y(v)}`).join('L') + 'L' + lower.map((v, i) => `${x(i)},${y(v)}`).reverse().join('L') + 'Z';
    lower = upper;
    return `<path d="${path}" class="${palette[ci % palette.length]}"><title>${esc(col.name)}</title></path>`;
  });
  const cfd = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Cumulative flow diagram for the last 30 days">
    ${niceTicks(maxTotal).map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${v}</text>`).join('')}
    ${areas.join('')}
    ${days.map((d, i) => i % 5 === 0 || i === days.length - 1 ? `<text x="${x(i)}" y="${H - 8}" class="tick" text-anchor="middle">${esc(pretty(d))}</text>` : '').join('')}
  </svg>${legend(stackOrder.map((c, i) => [palette[i % palette.length], c.name]).reverse())}`;

  const weekly = Array.from({ length: 8 }, (_, i) => { const end = now - (7 - i) * 7 * DAY; return completed.filter(c => { const d = new Date(c.doneAt).getTime(); return d > end - 7 * DAY && d <= end; }).length; });
  const aging = wip.map(c => ({ c, age: (now - new Date([...c.history].reverse().find(h => h.column === c.column)?.at || c.created)) / DAY })).sort((a, b) => b.age - a.age).slice(0, 8);
  const p85 = percentile(cycles, 0.85);

  $('#view').innerHTML = `<div class="stat-grid wide-stats">
      <div class="stat"><b>${wip.length}</b><span>Work in progress<br><small>started, not done</small></span></div>
      <div class="stat"><b>${inWindow(7).length}</b><span>Throughput<br><small>last 7 days</small></span></div>
      <div class="stat"><b>${inWindow(30).length}</b><span>Throughput<br><small>last 30 days</small></span></div>
      <div class="stat"><b>${cycles.length ? round1(sum(cycles, v => v) / cycles.length) + 'd' : '–'}</b><span>Avg cycle time<br><small>start → done, 30 days</small></span></div>
      <div class="stat"><b>${p85 != null ? round1(p85) + 'd' : '–'}</b><span>85th percentile<br><small>cycle time</small></span></div>
      <div class="stat"><b>${leads.length ? round1(sum(leads, v => v) / leads.length) + 'd' : '–'}</b><span>Avg lead time<br><small>created → done</small></span></div>
      <div class="stat ${blocked.length ? 'alert' : ''}"><b>${blocked.length}</b><span>Blocked<br><small>needs attention</small></span></div>
    </div>
    <div class="report-grid">
      <section class="panel wide"><div class="eyebrow">CUMULATIVE FLOW · LAST 30 DAYS</div>${cfd}<p class="muted small">Widening bands show work piling up in a stage. Parallel bands mean steady flow.</p></section>
      <section class="panel"><div class="eyebrow">WEEKLY THROUGHPUT</div>${lineChart({ series: [{ name: 'Cards finished', values: weekly, cls: 'actual', dots: true }], labels: weekly.map((_, i) => i === 7 ? 'This wk' : `-${7 - i}w`), yMax: Math.max(1, ...weekly), yLabel: 'cards' })}</section>
      <section class="panel"><div class="eyebrow">AGING WORK IN PROGRESS</div>
        ${aging.length ? `<table class="table"><thead><tr><th>Card</th><th>Column</th><th>Days</th></tr></thead><tbody>${aging.map(({ c, age }) => `<tr><td><a href="#" data-open-card="${esc(c.id)}">${esc(c.title)}</a>${c.blocked ? ' ⛔' : ''}</td><td>${esc(p.columns.find(col => col.id === c.column).name)}</td><td class="${p85 != null && age > p85 ? 'overdue' : ''}">${round1(age)}</td></tr>`).join('')}</tbody></table><p class="muted small">${p85 != null ? `Red: older than the 85th percentile cycle time (${round1(p85)} days).` : ''}</p>` : '<p class="muted">Nothing in progress.</p>'}
      </section>
    </div>`;
  $$('[data-open-card]').forEach(a => a.onclick = e => { e.preventDefault(); openCard(a.dataset.openCard); });
}

// ---------- card editor ----------
let editingCard = null, draftChecklist = [];
function openCard(id = null, preset = {}) {
  const p = project(), c = id ? p.cards.find(x => x.id === id) : null, f = $('#cardform').elements;
  editingCard = id;
  f.type.innerHTML = Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  f.priority.innerHTML = Object.entries(PRIORITIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  f.points.innerHTML = POINTS.map(x => `<option value="${x}">${x === '' ? 'Not estimated' : x}</option>`).join('');
  f.column.innerHTML = p.columns.map(col => `<option value="${esc(col.id)}">${esc(col.name)}</option>`).join('');
  const sprintOptions = p.sprints.filter(s => s.state !== 'closed' || s.id === c?.sprint);
  f.sprint.innerHTML = '<option value="">Product backlog</option>' + sprintOptions.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${s.state === 'active' ? ' (active)' : s.state === 'closed' ? ' (completed)' : ''}</option>`).join('');
  $('#sprintfield').hidden = p.type !== 'scrum';
  const v = c || { title: '', desc: '', type: 'story', priority: 'medium', points: '', column: p.columns[0].id, sprint: null, assignee: '', due: '', labels: [], blocked: false, blockedReason: '', checklist: [], ...preset };
  f.title.value = v.title; f.desc.value = v.desc; f.type.value = v.type; f.priority.value = v.priority; f.points.value = String(v.points);
  f.column.value = v.column; f.sprint.value = v.sprint || ''; f.assignee.value = v.assignee; f.due.value = v.due; f.labels.value = v.labels.join(', ');
  f.blocked.checked = v.blocked; f.blockedReason.value = v.blockedReason || '';
  $('#blockedreasonfield').hidden = !v.blocked;
  draftChecklist = v.checklist.map(x => ({ ...x }));
  renderChecklist();
  $('#cardheading').textContent = c ? 'Edit card' : 'New card';
  $('#cardeyebrow').textContent = (p.name + ' · ' + (p.type === 'scrum' ? 'Scrum' : 'Kanban')).toUpperCase();
  $('#deletecard').hidden = !c; $('#plancard').hidden = !c;
  $('#cardmeta').textContent = c ? `Created ${prettyY(c.created.slice(0, 10))}${c.doneAt ? ' · Done ' + prettyY(c.doneAt.slice(0, 10)) : ''}${flowTimes(p, c) ? ' · Cycle time ' + round1(flowTimes(p, c).cycle) + ' days' : ''}${c.updatedBy ? ` · Last edited by ${c.updatedBy}${c.updatedAt ? ' ' + ago(c.updatedAt) : ''}` : ''}` : '';
  $('#assignees').innerHTML = [...new Set([...(p.shared?.members || []).map(m => m.name), ...store.projects.flatMap(x => x.cards.map(c => c.assignee))].filter(Boolean))].map(a => `<option value="${esc(a)}">`).join('');
  const ro = isReadonly(p);
  $$('#cardform input, #cardform select, #cardform textarea, #cardform button').forEach(el => { if (!['cancelcard', 'plancard'].includes(el.id)) el.disabled = ro; });
  if (ro) { $('#cardheading').textContent = 'View card'; $('#deletecard').hidden = true; }
  $('#cardform button.primary').hidden = ro;
  $('#carddialog').showModal();
  f.title.focus();
}
function renderChecklist() {
  $('#checklist').innerHTML = draftChecklist.map((x, i) => `<div class="check-item"><input type="checkbox" data-ci="${i}" ${x.done ? 'checked' : ''} aria-label="Done"><span class="${x.done ? 'struck' : ''}">${esc(x.text)}</span><button type="button" class="icon" data-cdel="${i}" aria-label="Remove item">×</button></div>`).join('');
  $$('[data-ci]').forEach(b => b.onchange = () => { draftChecklist[b.dataset.ci].done = b.checked; renderChecklist(); });
  $$('[data-cdel]').forEach(b => b.onclick = () => { draftChecklist.splice(Number(b.dataset.cdel), 1); renderChecklist(); });
}
function addCheck() { const i = $('#newcheck'), text = i.value.trim(); if (!text) return; draftChecklist.push({ id: uid(), text, done: false }); i.value = ''; renderChecklist(); i.focus(); }
$('#addcheck').onclick = addCheck;
$('#newcheck').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addCheck(); } };
$('#cardform').elements.blocked.onchange = e => { $('#blockedreasonfield').hidden = !e.target.checked; };
$('#cardform').onsubmit = e => {
  e.preventDefault();
  const p = project(), f = e.target.elements, title = f.title.value.trim();
  if (!title) return;
  const fields = {
    title, desc: f.desc.value.trim(), type: f.type.value, priority: f.priority.value,
    points: f.points.value === '' ? '' : Number(f.points.value), assignee: f.assignee.value.trim(), due: f.due.value,
    labels: [...new Set(f.labels.value.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 12),
    blocked: f.blocked.checked, blockedReason: f.blocked.checked ? f.blockedReason.value.trim() : '', checklist: draftChecklist,
    sprint: p.type === 'scrum' ? f.sprint.value || null : null,
  };
  let card = editingCard && p.cards.find(c => c.id === editingCard);
  if (card) Object.assign(card, fields);
  else { card = newCard(p, { ...fields, column: p.columns[0].id }); card.order = -1; p.cards.push(card); }
  moveCard(p, card, f.column.value, null);
  if (!editingCard) { // new cards go to the top of their list
    const sibs = p.cards.filter(c => c.column === card.column && c !== card).sort((a, b) => a.order - b.order);
    [card, ...sibs].forEach((c, i) => (c.order = i));
  }
  save(); $('#carddialog').close(); render(); wipWarning(p, card.column);
};
$('#cancelcard').onclick = () => $('#carddialog').close();
$('#deletecard').onclick = () => {
  const p = project();
  if (!confirm('Delete this card? This cannot be undone.')) return;
  p.cards = p.cards.filter(c => c.id !== editingCard); save(); $('#carddialog').close(); render();
};
$('#plancard').onclick = () => { const c = project().cards.find(x => x.id === editingCard); $('#carddialog').close(); openPlan(c); };

// ---------- send to the Daycraft planner ----------
function openPlan(card) {
  const f = $('#planform').elements;
  $('#plantitle').textContent = card.title;
  f.date.value = card.due && card.due >= today() ? card.due : today();
  f.time.value = ''; f.duration.value = '60'; f.priority.checked = card.priority === 'urgent' || card.priority === 'high';
  $('#planform').dataset.title = card.title;
  $('#plandialog').showModal();
}
$('#planform').onsubmit = e => {
  e.preventDefault();
  const f = e.target.elements;
  let planner;
  try { planner = JSON.parse(localStorage.getItem(PLANNER_KEY)); } catch {}
  if (!planner || !Array.isArray(planner.tasks) || !planner.overrides) planner = { tasks: [], overrides: {} };
  planner.tasks.push({ id: uid(), title: e.target.dataset.title.slice(0, 140), scope: 'day', date: f.date.value, repeat: 'none', days: [], time: f.time.value, duration: Number(f.duration.value), priority: f.priority.checked, order: planner.tasks.filter(t => t.date === f.date.value).length });
  try { localStorage.setItem(PLANNER_KEY, JSON.stringify(planner)); } catch { return toast('Could not save to the planner.'); }
  $('#plandialog').close();
  toast(`Added to your planner for ${prettyY(f.date.value)}.`);
};
$('#cancelplan').onclick = () => $('#plandialog').close();

// ---------- projects ----------
let draftColumns = [];
function openProject(id = null) {
  const p = id ? store.projects.find(x => x.id === id) : null, f = $('#projectform').elements;
  f.name.value = p ? p.name : '';
  $$('#projectform [name=type]').forEach(r => { r.checked = r.value === (p ? p.type : 'scrum'); r.disabled = !!p; });
  $('#frameworkfield').hidden = !!p;
  f.sprintDays.value = String(p?.sprintDays || 14);
  draftColumns = p ? p.columns.map(c => ({ ...c })) : defaultColumns('scrum');
  renderColumns();
  $('#projectheading').textContent = p ? 'Project settings' : 'New project';
  $('#deleteproject').hidden = !p;
  $('#projectform').dataset.id = id || '';
  syncProjectType();
  $('#projectdialog').showModal();
}
function defaultColumns(type) {
  return (type === 'scrum' ? [['To do'], ['In progress', 3], ['Review'], ['Done']] : [['Backlog'], ['Ready', 5], ['Doing', 3], ['Review', 2], ['Done']]).map(([name, wip]) => ({ id: uid(), name, wip: wip || null }));
}
function syncProjectType() { const type = $('#projectform [name=type]:checked').value; $('#sprintlengthfield').hidden = type !== 'scrum'; }
$$('#projectform [name=type]').forEach(r => r.onchange = () => { if (!$('#projectform').dataset.id) { draftColumns = defaultColumns(r.value); renderColumns(); } syncProjectType(); });
function renderColumns() {
  $('#columnlist').innerHTML = draftColumns.map((c, i) => `<div class="column-row"><input value="${esc(c.name)}" maxlength="30" data-colname="${i}" aria-label="Column name" required><input type="number" min="1" max="99" value="${c.wip ?? ''}" placeholder="WIP" data-colwip="${i}" aria-label="WIP limit for ${esc(c.name)}" ${i === draftColumns.length - 1 ? 'disabled title="No WIP limit on Done"' : ''}>
    <button type="button" class="icon" data-colup="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="icon" data-coldown="${i}" aria-label="Move down" ${i === draftColumns.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="icon" data-coldel="${i}" aria-label="Remove column" ${draftColumns.length <= 2 ? 'disabled' : ''}>×</button></div>`).join('');
  $$('[data-colname]').forEach(el => el.oninput = () => (draftColumns[el.dataset.colname].name = el.value));
  $$('[data-colwip]').forEach(el => el.oninput = () => (draftColumns[el.dataset.colwip].wip = el.value ? Number(el.value) : null));
  const swap = (i, j) => { [draftColumns[i], draftColumns[j]] = [draftColumns[j], draftColumns[i]]; renderColumns(); };
  $$('[data-colup]').forEach(b => b.onclick = () => swap(+b.dataset.colup, +b.dataset.colup - 1));
  $$('[data-coldown]').forEach(b => b.onclick = () => swap(+b.dataset.coldown, +b.dataset.coldown + 1));
  $$('[data-coldel]').forEach(b => b.onclick = () => { draftColumns.splice(+b.dataset.coldel, 1); renderColumns(); });
}
$('#addcolumn').onclick = () => { draftColumns.splice(draftColumns.length - 1, 0, { id: uid(), name: 'New column', wip: null }); renderColumns(); };
$('#projectform').onsubmit = e => {
  e.preventDefault();
  const f = e.target.elements, id = e.target.dataset.id, name = f.name.value.trim();
  const columns = draftColumns.map(c => ({ ...c, name: c.name.trim() || 'Untitled' }));
  columns[columns.length - 1].wip = null;
  if (id) {
    const p = store.projects.find(x => x.id === id);
    const keep = new Set(columns.map(c => c.id)), wasDone = doneColumn(p).id;
    p.name = name; p.sprintDays = Number(f.sprintDays.value); p.columns = columns;
    p.cards.forEach(c => { if (!keep.has(c.column)) moveCard(p, c, columns[0].id); });
    if (wasDone !== doneColumn(p).id) p.cards.forEach(c => { c.doneAt = isDone(p, c) ? c.doneAt || new Date().toISOString() : null; });
  } else {
    const type = $('#projectform [name=type]:checked').value;
    const p = { id: uid(), name, type, sprintDays: Number(f.sprintDays.value), columns, cards: [], sprints: [], standups: [], createdAt: new Date().toISOString() };
    store.projects.push(p); ui.project = p.id; ui.view = VIEWS[type][0][0];
  }
  save(); $('#projectdialog').close(); render();
};
$('#cancelproject').onclick = () => $('#projectdialog').close();
$('#deleteproject').onclick = async () => {
  const id = $('#projectform').dataset.id, p = store.projects.find(x => x.id === id);
  if (p.shared) { $('#projectdialog').close(); return openShare(); }
  if (!confirm(`Delete “${p.name}” and all ${p.cards.length} cards? Export first if you need a copy.`)) return;
  store.projects = store.projects.filter(x => x.id !== id); ui.project = store.projects[0]?.id; save(); $('#projectdialog').close(); render();
};
$('#newproject').onclick = () => openProject();
$('#projectsettings').onclick = () => project() && openProject(project().id);
$('#projectselect').onchange = e => { ui.project = e.target.value; ui.view = null; saveUi(); render(); };

// ---------- filters & toolbar ----------
$('#search').oninput = e => { ui.filters.q = e.target.value; saveUi(); render(); };
$('#filtertype').onchange = e => { ui.filters.type = e.target.value; saveUi(); render(); };
$('#filterassignee').onchange = e => { ui.filters.assignee = e.target.value; saveUi(); render(); };
$('#filterlabel').onchange = e => { ui.filters.label = e.target.value; saveUi(); render(); };
$('#swimlanes').onchange = e => { ui.filters.lanes = e.target.value; saveUi(); render(); };
$('#clearfilters').onclick = () => { ui.filters = { lanes: ui.filters.lanes }; saveUi(); render(); };
$('#newcard').onclick = () => {
  const p = project(); if (!p) return;
  openCard(null, p.type === 'scrum' && ui.view === 'sprint' && activeSprint(p) ? { sprint: activeSprint(p).id } : {});
};

// ---------- export / import ----------
$('#exportboards').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' }));
  a.download = 'bas-planner-boards-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#importboards').onclick = () => $('#boardsfile').click();
$('#boardsfile').onchange = async e => {
  try {
    const next = JSON.parse(await e.target.files[0].text());
    if (!validStore(next)) throw Error();
    if (confirm('Replace all boards with this backup? Export first if you need to keep the current ones.')) { store = next; ui.project = store.projects[0]?.id; save(); render(); toast('Boards restored.'); }
  } catch { toast('That file is not a valid BAS Planner boards backup.'); }
  e.target.value = '';
};

// ---------- shared boards (server sync) ----------
// A shared project keeps `shared = { id, key, role, rev, base }` where `base` is the last
// document received from the server. Local edits are sent as a patch (base → current);
// remote changes are merged by re-applying any unsent local edits on top of the server copy.
const DOC_FIELDS = ['name', 'sprintDays', 'columns'];
const DOC_COLLS = ['cards', 'sprints', 'standups'];
const syncing = new Map(); // project id -> { inflight, timer, status }
let pendingRender = false;

const clone = v => JSON.parse(JSON.stringify(v));
const docOf = p => clone({ type: p.type, createdAt: p.createdAt, name: p.name, sprintDays: p.sprintDays, columns: p.columns, cards: p.cards, sprints: p.sprints, standups: p.standups || [] });
const isReadonly = p => p.shared?.role === 'viewer' || p.shared?.role === 'public';
const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer', public: 'Public view link' };
function replaceDoc(p, doc) { const d = clone(doc); for (const k of ['type', 'createdAt', ...DOC_FIELDS, ...DOC_COLLS]) p[k] = d[k]; }

function diffDocs(a, b) {
  const ops = { set: {}, upsert: {}, remove: {} }; let n = 0;
  for (const f of DOC_FIELDS) if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) { ops.set[f] = b[f]; n++; }
  for (const c of DOC_COLLS) {
    const before = new Map((a[c] || []).map(x => [x.id, JSON.stringify(x)])), seen = new Set();
    for (const x of b[c] || []) { seen.add(x.id); if (before.get(x.id) !== JSON.stringify(x)) { (ops.upsert[c] = ops.upsert[c] || []).push(x); n++; } }
    for (const id of before.keys()) if (!seen.has(id)) { (ops.remove[c] = ops.remove[c] || []).push(id); n++; }
  }
  return n ? ops : null;
}
function applyDocOps(doc, ops) {
  const next = clone(doc);
  if (!ops) return next;
  Object.assign(next, clone(ops.set || {}));
  for (const c of DOC_COLLS) {
    const map = new Map((next[c] || []).map(x => [x.id, x]));
    for (const id of ops.remove?.[c] || []) map.delete(id);
    for (const x of ops.upsert?.[c] || []) map.set(x.id, clone(x));
    next[c] = [...map.values()];
  }
  return next;
}

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function boardsApi(mode, { id, since, key, body } = {}) {
  const q = new URLSearchParams({ mode, ...(id ? { id } : {}), ...(since != null ? { since } : {}) });
  let res;
  try {
    res = await fetch('/api/boards?' + q, { method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'You appear to be offline.'); }
  let json; try { json = await res.json(); } catch { throw new ApiError(res.status || 0, 'The server is unavailable.'); }
  if (!res.ok) throw new ApiError(res.status, json.error || 'Something went wrong.');
  return json;
}
const randomKey = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
const shareLink = (id, key) => `${location.origin}/boards#board=${encodeURIComponent(id)}&key=${key}`;

function state(p) { if (!syncing.has(p.id)) syncing.set(p.id, { inflight: false, timer: null, status: 'synced' }); return syncing.get(p.id); }
function setStatus(p, status) { state(p).status = status; if (p === project()) showStatus(); }
function showStatus() {
  const p = project(), el = $('#syncstatus');
  if (!p?.shared) { el.textContent = '● Saved on this device'; el.className = 'sync-status'; return; }
  const st = state(p).status;
  el.className = 'sync-status shared ' + st;
  const who = p.shared.me ? ` · ${p.shared.me.name}` : '';
  el.textContent = st === 'saving' ? '● Saving…' : st === 'offline' ? '● Offline · will retry' : isReadonly(p) ? `● Shared · view only${who}` : `● Shared · up to date${who}`;
}

// View-only copies can't be edited: undo any local change.
function guardReadonly() {
  for (const p of store.projects) if (isReadonly(p) && diffDocs(p.shared.base, docOf(p))) { replaceDoc(p, p.shared.base); toast('This board is view-only.'); }
}

function queueSyncAll() {
  for (const p of store.projects) {
    if (!p.shared || isReadonly(p)) continue;
    const st = state(p);
    clearTimeout(st.timer);
    st.timer = setTimeout(() => syncProject(p.id), 300);
  }
}

// Remote changes arrived: keep unsent local edits on top of the new server copy.
function mergeRemote(p, remote, sentFrom = p.shared.base) {
  const pending = diffDocs(sentFrom, docOf(p));
  const before = JSON.stringify(docOf(p)), roleBefore = p.shared.role;
  replaceDoc(p, applyDocOps(remote.doc, pending));
  p.shared.base = remote.doc; p.shared.rev = remote.rev;
  rememberTeam(p, remote);
  if (isReadonly(p)) replaceDoc(p, remote.doc); // a viewer has nothing to send
  persist();
  if (p === project() && (JSON.stringify(docOf(p)) !== before || p.shared.role !== roleBefore)) safeRender();
  return isReadonly(p) ? null : pending;
}

async function syncProject(pid) {
  const p = store.projects.find(x => x.id === pid);
  if (!p?.shared || isReadonly(p)) return;
  const st = state(p);
  if (st.inflight) { st.again = true; return; }
  const ops = diffDocs(p.shared.base, docOf(p));
  if (!ops) { setStatus(p, 'synced'); return; }
  st.inflight = true; st.again = false; setStatus(p, 'saving');
  const sent = docOf(p);
  try {
    const remote = await boardsApi('patch', { id: p.shared.id, key: p.shared.key, body: { baseRev: p.shared.rev, ops } });
    const pending = mergeRemote(p, remote, sent);
    st.inflight = false;
    if (pending || st.again) syncProject(pid); else setStatus(p, 'synced');
  } catch (e) {
    st.inflight = false;
    if (!handleAccessError(p, e)) { setStatus(p, 'offline'); clearTimeout(st.timer); st.timer = setTimeout(() => syncProject(pid), 5000); }
  }
}

async function pollProject(p) {
  if (!p?.shared || state(p).inflight) return;
  try {
    const remote = await boardsApi('get', { id: p.shared.id, key: p.shared.key, since: p.shared.rev });
    if (state(p).inflight || !store.projects.includes(p)) return;
    if (!remote.unchanged) { const pending = mergeRemote(p, remote); if (pending && !isReadonly(p)) queueSyncAll(); }
    if (state(p).status === 'offline' && !diffDocs(p.shared.base, docOf(p))) setStatus(p, 'synced');
  } catch (e) { if (!handleAccessError(p, e)) setStatus(p, 'offline'); }
}

// Keep the team details (who I am, members, activity) that come back with each response.
function rememberTeam(p, remote) {
  if (remote.role) p.shared.role = remote.role;
  for (const k of ['me', 'members', 'activity', 'viewLink']) if (remote[k] !== undefined) p.shared[k] = remote[k];
  if (p.shared.viewLink && !p.shared.viewLink.enabled) delete p.shared.viewKey;
  if ($('#sharedialog').open && p === project()) renderTeam();
}

function handleAccessError(p, e) {
  if (e.status !== 404 && e.status !== 403) return false;
  if (e.status === 403) { p.shared.role = 'viewer'; replaceDoc(p, p.shared.base); persist(); render(); toast('You can now only view this board.'); pollProject(p); return true; }
  delete p.shared; p.name = p.name + ' (local copy)'; persist(); render();
  toast('Your link to this shared board no longer works: it was reset, you were removed, or the board was deleted. A local copy has been kept on this device.');
  return true;
}

function safeRender() {
  const a = document.activeElement;
  if (a && a.closest('#view') && a.matches('input,textarea,select')) { pendingRender = true; return; }
  render();
}
$('#view').addEventListener('focusout', () => setTimeout(() => { if (pendingRender && !document.activeElement?.closest('#view input,#view textarea,#view select')) render(); }, 0));

setInterval(() => { if (document.visibilityState === 'visible') pollProject(project()); }, 8000);
window.addEventListener('focus', () => pollProject(project()));
window.addEventListener('online', () => queueSyncAll());

// Team dialog: sharing, members, roles, link resets and the public view link
const ago = iso => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 2 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : prettyY(iso.slice(0, 10));
};
let freshLink = null; // { label, url, hint } shown once after sharing, an invite or a reset

function openShare() { freshLink = null; renderTeam(); if (!$('#sharedialog').open) $('#sharedialog').showModal(); }

function renderTeam() {
  const p = project(), body = $('#sharebody');
  if (!p) return;
  if (!p.shared) {
    $('#shareheading').textContent = 'Share this project';
    body.innerHTML = `<p>Put <strong>${esc(p.name)}</strong> on the BAS Planner server so your team can work on it together. Changes sync automatically.</p>
      <ul class="share-points"><li>Invite people by name as <strong>editors</strong> (can change the board) or <strong>viewers</strong> (can follow along). Each person gets their own private link.</li>
      <li>Reset anyone’s link if it leaks. The old link stops working straight away.</li>
      <li>Optionally turn on a <strong>public view-only link</strong> for stakeholders.</li></ul>
      <form id="startshareform"><label>Your name<input name="name" required maxlength="40" value="${esc(ui.myName || '')}" placeholder="How your team knows you"></label>
      <button class="primary" id="startshare">Share on server</button></form><p class="share-error" role="alert"></p>`;
    $('#startshareform').onsubmit = async e => {
      e.preventDefault();
      const btn = $('#startshare'), name = e.target.elements.name.value.trim(); if (!name) return;
      btn.disabled = true; btn.textContent = 'Sharing…';
      const key = randomKey();
      try {
        const remote = await boardsApi('create', { key, body: { doc: docOf(p), name } });
        ui.myName = name;
        p.shared = { id: remote.id, key, rev: remote.rev, base: remote.doc };
        rememberTeam(p, remote); replaceDoc(p, remote.doc); persist(); render();
        freshLink = { label: 'Your personal link', url: shareLink(remote.id, key), hint: 'save it to open the board on another device' };
        renderTeam(); toast('Shared. Now invite your team.');
      } catch (err) { $('.share-error').textContent = err.message; btn.disabled = false; btn.textContent = 'Share on server'; }
    };
    return;
  }

  const sh = p.shared, owner = sh.role === 'owner', me = sh.me;
  $('#shareheading').textContent = sh.role === 'public' ? 'Shared project · public view' : 'Team';
  const linkBox = (label, url, hint, idn) => `<div class="link-box"><strong>${esc(label)}</strong>${hint ? `<span class="muted small"> · ${esc(hint)}</span>` : ''}<div class="link-row"><input readonly value="${esc(url)}" id="${idn}" aria-label="${esc(label)}"><button type="button" data-copy="${idn}">Copy</button></div></div>`;

  if (sh.role === 'public') {
    body.innerHTML = `<p class="muted">You’re viewing this board through a public view-only link. Ask an owner to invite you by name if you need to make changes.</p>
      <div class="share-actions"><button type="button" id="leaveshare">Remove from this device</button></div>`;
  } else {
    const members = sh.members || [];
    const memberRow = m => {
      const isMe = me && m.id === me.id;
      return `<div class="member-row" data-member="${esc(m.id)}">
        <span class="avatar">${esc(initials(m.name))}</span>
        <div class="member-info"><strong>${esc(m.name)}${isMe ? ' <span class="muted small">(you)</span>' : ''}</strong><span class="muted small">Last active ${esc(ago(m.last_seen))}${m.link_reset_at ? ' · link reset ' + esc(ago(m.link_reset_at)) : ''}</span></div>
        ${owner ? `<select data-role="${esc(m.id)}" aria-label="Role for ${esc(m.name)}">${['owner', 'editor', 'viewer'].map(r => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>` : `<span class="role-pill ${esc(m.role)}">${ROLE_LABEL[m.role]}</span>`}
        ${owner || isMe ? `<button type="button" class="small-btn" data-reset="${esc(m.id)}" title="Make a new link; the old one stops working">Reset link</button>` : ''}
        ${owner && !isMe ? `<button type="button" class="icon" data-remove="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">×</button>` : ''}
      </div>`;
    };
    const vl = sh.viewLink;
    body.innerHTML = `
      ${freshLink ? `<div class="fresh-link">${linkBox(freshLink.label, freshLink.url, freshLink.hint, 'freshlink')}<p class="small">Copy it now and send it privately. BAS Planner can’t show this link again, but you can reset it to get a new one.</p></div>` : ''}
      <h3 class="team-h">Members <span class="muted small">${members.length}</span></h3>
      <div class="member-list">${members.map(memberRow).join('')}</div>
      ${owner ? `<form id="inviteform" class="invite-row"><input name="name" required maxlength="40" placeholder="Name" aria-label="Name to invite"><select name="role" aria-label="Role"><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="owner">Owner</option></select><button class="primary">Invite</button></form>
        <p class="muted small">Editors can change cards, sprints and notes. Viewers can only look. Owners can also manage members and links.</p>` : ''}
      ${me ? linkBox('Your personal link', shareLink(sh.id, sh.key), 'open this board on another device', 'mylink') : ''}
      ${owner ? `<h3 class="team-h">Public view-only link</h3>
        ${vl?.enabled ? (sh.viewKey ? linkBox('Public link', shareLink(sh.id, sh.viewKey), 'anyone with it can view', 'publink') : `<p class="muted small">On since ${esc(ago(vl.created_at))}. Reset it to get a link you can copy here.</p>`) + '<div class="share-actions inline"><button type="button" id="rotatepublic">Reset public link</button><button type="button" id="disablepublic">Turn off</button></div>'
          : '<p class="muted small">Off. Turn it on to let stakeholders follow the board without being members.</p><button type="button" id="enablepublic">Turn on public link</button>'}` : ''}
      <details class="activity"><summary>Recent activity</summary>${(sh.activity || []).map(a => `<div class="activity-row"><strong>${esc(a.by)}</strong> ${esc(a.summary)} <span class="muted small">${esc(ago(a.at))}</span></div>`).join('') || '<p class="muted small">Nothing yet.</p>'}</details>
      <div class="share-actions"><button type="button" id="leaveshare">${me ? 'Leave board' : 'Remove from this device'}</button>${owner ? '<button type="button" class="danger" id="deleteshare">Delete for everyone</button>' : ''}</div>`;
  }
  body.insertAdjacentHTML('beforeend', '<p class="share-error" role="alert"></p>');
  bindTeam(p);
}

async function teamCall(p, mode, payload) {
  try {
    const remote = await boardsApi(mode, { id: p.shared.id, key: p.shared.key, body: payload });
    rememberTeam(p, remote); persist(); return remote;
  } catch (e) {
    if (!handleAccessError(p, e)) { const el = $('.share-error'); if (el) el.textContent = e.message; }
    return null;
  }
}

function bindTeam(p) {
  const sh = p.shared;
  $$('[data-copy]').forEach(b => b.onclick = async () => {
    const input = $('#' + b.dataset.copy);
    try { await navigator.clipboard.writeText(input.value); b.textContent = 'Copied'; } catch { input.select(); b.textContent = 'Press Ctrl+C'; }
    setTimeout(() => (b.textContent = 'Copy'), 2000);
  });
  if (!sh) return;
  $('#inviteform')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements, key = randomKey();
    const r = await teamCall(p, 'invite', { name: f.name.value.trim(), role: f.role.value, key });
    if (r) { freshLink = { label: `${r.member.name}’s link (${ROLE_LABEL[r.member.role].toLowerCase()})`, url: shareLink(sh.id, key) }; renderTeam(); }
  });
  $$('[data-role]').forEach(sel => sel.onchange = async () => { if (!(await teamCall(p, 'member', { memberId: sel.dataset.role, role: sel.value }))) renderTeam(); });
  $$('[data-remove]').forEach(b => b.onclick = async () => {
    const m = sh.members.find(x => x.id === b.dataset.remove);
    if (confirm(`Remove ${m.name} from this board? Their link stops working.`)) { await teamCall(p, 'member', { memberId: m.id, remove: true }); renderTeam(); }
  });
  $$('[data-reset]').forEach(b => b.onclick = async () => {
    const m = sh.members.find(x => x.id === b.dataset.reset), self = sh.me && m.id === sh.me.id;
    if (!confirm(self ? 'Reset your personal link? Your old link stops working on every device; this device switches to the new one.' : `Reset ${m.name}’s link? Their old link stops working and you’ll need to send them the new one.`)) return;
    const key = randomKey();
    if (self) {
      // Switch this device to the new key as soon as the server accepts it.
      try { const r = await boardsApi('rotate', { id: sh.id, key: sh.key, body: { memberId: m.id, key } }); sh.key = key; rememberTeam(p, r); persist(); }
      catch (e) { $('.share-error').textContent = e.message; return; }
    } else if (!(await teamCall(p, 'rotate', { memberId: m.id, key }))) return;
    freshLink = { label: self ? 'Your new personal link' : `${m.name}’s new link`, url: shareLink(sh.id, key) };
    renderTeam();
  });
  const publicLink = async action => {
    const key = action === 'disable' ? undefined : randomKey();
    if (await teamCall(p, 'viewlink', { action, key })) { if (key) sh.viewKey = key; else delete sh.viewKey; persist(); renderTeam(); }
  };
  $('#enablepublic')?.addEventListener('click', () => publicLink('enable'));
  $('#rotatepublic')?.addEventListener('click', () => confirm('Reset the public link? The current one stops working.') && publicLink('rotate'));
  $('#disablepublic')?.addEventListener('click', () => confirm('Turn off the public link? Anyone using it loses access.') && publicLink('disable'));
  $('#leaveshare').onclick = async () => {
    const member = !!sh.me;
    if (!confirm(member ? `Leave “${p.name}”? You’ll need a new invite to come back. A local copy stays on this device.` : `Remove “${p.name}” from this device?`)) return;
    if (member && !(await teamCall(p, 'leave', {}))) return;
    if (member) { delete p.shared; p.name += ' (local copy)'; }
    else store.projects = store.projects.filter(x => x !== p);
    ui.project = (store.projects.includes(p) ? p : store.projects[0])?.id; persist(); $('#sharedialog').close(); render();
  };
  $('#deleteshare')?.addEventListener('click', async () => {
    if (!confirm(`Delete “${p.name}” for everyone? Every link stops working and the board is removed from the server. This cannot be undone.`)) return;
    try { await boardsApi('delete', { id: sh.id, key: sh.key, body: {} }); }
    catch (e) { if (e.status !== 404) { $('.share-error').textContent = e.message; return; } }
    store.projects = store.projects.filter(x => x !== p); ui.project = store.projects[0]?.id; persist(); $('#sharedialog').close(); render();
    toast('Shared board deleted.');
  });
}
$('#sharebtn').onclick = openShare;
$('#closeshare').onclick = () => $('#sharedialog').close();

// Opening a share link: /boards#board=<id>&key=<key>
async function joinFromLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get('board'), key = params.get('key');
  if (!id || !key) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (!/^[a-f0-9]{64}$/.test(key)) return toast('That board link is not valid.');
  try {
    const remote = await boardsApi('get', { id, key });
    let p = store.projects.find(x => x.shared?.id === id);
    const rank = { public: 0, viewer: 1, editor: 2, owner: 3 };
    if (p) {
      if (rank[remote.role] >= rank[p.shared.role] || remote.me) { p.shared.key = key; delete p.shared.me; }
      mergeRemote(p, remote);
    } else {
      p = { id: uid(), shared: { id, key, rev: remote.rev, base: remote.doc } };
      rememberTeam(p, remote); replaceDoc(p, remote.doc); store.projects.push(p);
    }
    if (remote.me) ui.myName = remote.me.name;
    ui.project = p.id; ui.view = null; persist(); render();
    toast(remote.me ? `Welcome, ${remote.me.name}. You’re ${remote.role === 'owner' ? 'an owner' : remote.role === 'editor' ? 'an editor' : 'a viewer'} on “${p.name}”.` : `Opened “${p.name}” (view only).`);
  } catch (e) { toast(e.status === 404 ? 'This shared board no longer exists, or the link is not valid.' : e.message); }
}
window.addEventListener('hashchange', joinFromLink);

// ---------- main render ----------
function render() {
  const p = project();
  $('#projectselect').innerHTML = store.projects.map(x => `<option value="${esc(x.id)}" ${x.id === p?.id ? 'selected' : ''}>${x.shared ? (isReadonly(x) ? '👁 ' : '👥 ') : ''}${esc(x.name)}</option>`).join('');
  document.body.classList.toggle('readonly', !!p && isReadonly(p));
  $('#sharebtn').hidden = !p;
  $('#sharebtn').textContent = p?.shared ? (p.shared.members ? `👥 Team · ${p.shared.members.length}` : '👁 Shared') : '🔗 Share';
  showStatus();
  if (!p) {
    $('#projecttype').textContent = ''; $('#viewtabs').innerHTML = ''; $('#filterbar').hidden = true; $('#projectsettings').hidden = true;
    $('#view').innerHTML = '<div class="empty-state"><h2>Make room for the work that matters</h2><p>Create a Scrum project for time-boxed sprints, or a Kanban project for continuous flow.</p><button class="primary" id="firstproject">＋ Create a project</button></div>';
    $('#firstproject').onclick = () => openProject();
    return;
  }
  $('#projectsettings').hidden = false;
  if (!VIEWS[p.type].some(([k]) => k === ui.view)) ui.view = p.type === 'scrum' ? (activeSprint(p) ? 'sprint' : 'backlog') : 'board';
  $('#projecttype').textContent = p.type === 'scrum' ? 'Scrum' : 'Kanban';
  $('#projecttype').className = 'type-pill ' + p.type;
  $('#viewtabs').innerHTML = VIEWS[p.type].map(([k, label]) => `<button role="tab" aria-selected="${ui.view === k}" data-view="${k}">${label}</button>`).join('');
  $$('[data-view]').forEach(b => b.onclick = () => { ui.view = b.dataset.view; saveUi(); render(); });

  const showFilters = ['backlog', 'sprint', 'board'].includes(ui.view);
  $('#filterbar').hidden = !showFilters;
  $('#swimlanes').hidden = ui.view === 'backlog';
  const f = ui.filters;
  const assignees = [...new Set(p.cards.map(c => c.assignee).filter(Boolean))].sort();
  const labels = [...new Set(p.cards.flatMap(c => c.labels))].sort();
  $('#filtertype').innerHTML = '<option value="">All types</option>' + Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#filterassignee').innerHTML = '<option value="">Anyone</option><option value="__none">Unassigned</option>' + assignees.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
  $('#filterlabel').innerHTML = '<option value="">All labels</option>' + labels.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
  $('#search').value = f.q || ''; $('#filtertype').value = f.type || ''; $('#filterassignee').value = f.assignee || ''; $('#filterlabel').value = f.label || ''; $('#swimlanes').value = f.lanes || '';
  if ($('#filterassignee').value !== (f.assignee || '')) f.assignee = '';
  if ($('#filterlabel').value !== (f.label || '')) f.label = '';

  ({ backlog: renderBacklog, sprint: renderSprintBoard, reports: renderReports, ceremonies: renderCeremonies, board: renderKanban, metrics: renderMetrics })[ui.view](p);
  if (isReadonly(p)) $$('#view [draggable]').forEach(el => (el.draggable = false));
  pendingRender = false;
  saveUi();
}

window.addEventListener('storage', e => { if (e.key === STORE_KEY) { load(); render(); } });
document.addEventListener('keydown', e => {
  if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]') || e.target.closest('input,textarea,select,[contenteditable]')) return;
  e.preventDefault(); $('#newcard').click();
});

load();
render();
joinFromLink();
pollProject(project());
})();
