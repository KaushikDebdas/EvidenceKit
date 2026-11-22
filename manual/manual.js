import { dbPut, dbPutIfExists, dbDelMany, dbGet, dbDel, dbClear, getSteps, uid } from '../lib/db.js';
import { syncNumber } from '../lib/stepimg.js';
import { fmtTime, fileStamp, formatDate } from '../lib/compose.js';
import { STATUS_OPTIONS, statusOf, tcIdOf, countStatus, buildEvidenceHtml, buildEvidenceMd } from './evidence-export.js';
import { makeBackup, readBackup, KV_KEYS } from './backup.js';
import { manualDocx, evidenceDocx } from './docx-export.js';
import { DOC_NAMES, docOf, activeDoc, setActiveDoc, pendingBatches, resolveBatch } from '../lib/docs.js';

// The manual is one ordered list in the "steps" store. Items with type:'section' are section headings
// (e.g. "Registration", "Login"); every step after a heading belongs to that section until the next heading.
// Two document types share that list:
//   User Manual    sections + steps, for the people who use the application
//   Test Evidence  every section is a test case (s.tc = { id, status, bug, pre, expected, actual });
//                  a step can be a checkpoint with its own expected / actual / status (s.check, s.expected …)
const $ = (id) => document.getElementById(id);
let steps = []; // steps AND section headings, in order
let urls = [];
let signature = '';
const brand = { color: '#4f46e5', logo: null, logoUrl: '', toc: true };
const isSec = (s) => s && s.type === 'section';
let mode = 'manual'; // 'manual' | 'evidence'   (kv: manualMode)
const isEv = () => mode === 'evidence';
const info = { project: '', ticket: '', build: '', env: '', tester: '', date: '', shots: 'all' }; // kv: evidenceInfo
const titleKey = () => (isEv() ? 'evidenceTitle' : 'manualTitle');
const today = () => formatDate(new Date(), 'DD MMM YYYY');
const word = (manualWord, evidenceWord) => (isEv() ? evidenceWord : manualWord);

$('okClose').addEventListener('click', () => $('okbar').classList.remove('show'));
function showOk(title, detail) {
  const b = $('okbar');
  b.querySelector('.okt').textContent = title;
  b.querySelector('.okd').textContent = detail || '';
  b.classList.add('show');
  clearTimeout(showOk._t);
  showOk._t = setTimeout(() => b.classList.remove('show'), 3000);
}
function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

const sigOf = (list) => list.map((s) => `${s.id}:${s.order}:${s.rev || 0}`).join('|');
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slug = (s) => String(s || 'manual').trim().replace(/[^\w.-]+/g, '_').slice(0, 60) || 'manual';
const nowText = () => fmtTime(Date.now(), { timeFormat: '12', dateFormat: 'DD MMM YYYY', showTz: false });

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// typing is saved 300 ms later; dbPutIfExists makes sure a step deleted in between does not come back
const saveTimers = {};
function saveSoon(step) {
  clearTimeout(saveTimers[step.id]);
  saveTimers[step.id] = setTimeout(() => { delete saveTimers[step.id]; dbPutIfExists('steps', step); }, 300);
}
function cancelSaves(ids) {
  for (const id of ids || Object.keys(saveTimers)) { clearTimeout(saveTimers[id]); delete saveTimers[id]; }
}
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

// ---------------- structure: sections with their steps ----------------
// [{ sec: heading item | null (steps before the first heading), items: [steps] }]
function groups(list = steps) {
  const out = [];
  let cur = null;
  for (const s of list) {
    if (isSec(s)) { cur = { sec: s, items: [] }; out.push(cur); }
    else {
      if (!cur) { cur = { sec: null, items: [] }; out.push(cur); }
      cur.items.push(s);
    }
  }
  return out;
}
const prevStep = (i) => { for (let k = i - 1; k >= 0; k--) if (!isSec(steps[k])) return steps[k]; return null; };

// ---------------- rule-based title / description suggestions (nothing leaves the computer) ----------------
function hostPath(url) {
  try { const u = new URL(url); return u.hostname + (u.pathname !== '/' ? u.pathname : ''); } catch (e) { return ''; }
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export function suggest(s, prev) {
  const page = clip(String(s.pageTitle || '').trim() || hostPath(s.url) || 'the page', 60);
  const samePage = prev && prev.url && s.url && hostPath(prev.url) === hostPath(s.url);
  let title;
  if (s.auto && s.title) title = s.title; // step guide / recording steps already describe the action
  else if (s.mode === 'area' || s.mode === 'element' || s.mode === 'dual') title = `Check this part of “${page}”`;
  else if (s.mode === 'scroll') title = `Scroll through the list on “${page}”`;
  else if (s.mode === 'mobile') title = `Open “${page}” on a phone`;
  else if (s.mode === 'split') title = 'Compare the pages side by side';
  else if (s.mode === 'full') title = samePage ? `Scroll down “${page}”` : `Open “${page}”`;
  else if (s.url && !samePage) title = `Go to “${page}”`;
  else if (s.url) title = `Check “${page}”`;
  else title = 'Look at the screen';
  const DESC = {
    click: 'Click the highlighted element.',
    type: 'Type into the highlighted field.',
    select: 'Choose the option in the highlighted list.',
    upload: 'Choose the file to upload.',
  };
  let desc = DESC[s.kind] || '';
  if (!desc && s.url) desc = `Page: ${s.url}`;
  return { title: clip(title, 100), desc };
}

async function applySuggestions(force) {
  let n = 0;
  steps.forEach((s, i) => {
    if (isSec(s)) return;
    if (!force && (s.title || s.sugDone)) return;
    const sg = suggest(s, prevStep(i));
    if (force || !s.title) s.title = sg.title;
    if (!s.desc) s.desc = sg.desc;
    s.sugDone = true;
    dbPutIfExists('steps', s);
    n++;
  });
  return n;
}

async function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= steps.length) return;
  const a = steps[i], b = steps[j];
  [a.order, b.order] = [b.order, a.order];
  await dbPutIfExists('steps', a);
  await dbPutIfExists('steps', b);
  await reload(true);
}

// ---------------- sections ----------------
async function addSection(beforeIndex, title) {
  let order;
  if (beforeIndex == null || beforeIndex >= steps.length) order = steps.reduce((m, s) => Math.max(m, s.order), 0) + 1;
  else {
    const next = steps[beforeIndex].order;
    const prev = beforeIndex > 0 ? steps[beforeIndex - 1].order : next - 1;
    order = (prev + next) / 2; // between the two neighbours
  }
  const sec = { id: uid(), type: 'section', doc: mode, order, title: title || '', ts: Date.now() };
  await dbPut('steps', sec);
  await reload(true);
  const inp = document.querySelector(`[data-sec="${sec.id}"] .sec-title`);
  if (inp) { inp.focus(); inp.scrollIntoView({ block: 'center' }); }
  return sec;
}

// ---------------- branding ----------------
function applyBrand() {
  document.body.style.setProperty('--brand', brand.color);
  $('brandColor').value = brand.color;
  $('tocOn').checked = brand.toc;
  if (brand.logoUrl) URL.revokeObjectURL(brand.logoUrl);
  brand.logoUrl = brand.logo ? URL.createObjectURL(brand.logo) : '';
  $('logoImg').hidden = !brand.logo;
  if (brand.logo) $('logoImg').src = brand.logoUrl;
  $('logoDel').hidden = !brand.logo;
  renderToc();
}
async function loadBrand() {
  const r = await dbGet('kv', 'manualBrand');
  const v = (r && r.value) || {};
  Object.assign(brand, { color: v.color || '#4f46e5', toc: v.toc !== false, logo: v.logo || null });
  applyBrand();
}
const saveBrand = () => dbPut('kv', { key: 'manualBrand', value: { color: brand.color, toc: brand.toc, logo: brand.logo } });

// ---------------- document type: User Manual / Test Evidence ----------------
async function loadDocState() {
  const m = await dbGet('kv', 'manualMode');
  mode = m && m.value === 'evidence' ? 'evidence' : 'manual';
  const i = await dbGet('kv', 'evidenceInfo');
  Object.assign(info, { project: '', ticket: '', build: '', env: '', tester: '', date: '', shots: 'all' }, (i && i.value) || {});
  document.querySelectorAll('[data-info]').forEach((el) => { el.value = info[el.dataset.info] || ''; });
  $('shotScope').value = ['all', 'key', 'none'].includes(info.shots) ? info.shots : 'all';
  await applyMode();
}
async function applyMode() {
  document.body.classList.toggle('evidence', isEv());
  document.querySelectorAll('.modeseg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('barTitle').textContent = word('User Manual builder', 'Test Evidence builder');
  $('barHint').textContent = word(
    'Add screenshots with “After capture → Add to Manual / Test Evidence” or the editor’s “Add to Manual”. Paste (Ctrl+V) an image here to add it as a step.',
    'Each section is a test case: write its expected and actual result once. Mark a step as ◎ Checkpoint only where you verify something.');
  $('addSection').textContent = word('＋ Section', '＋ Test case');
  $('addSection').title = word('Add a section heading (e.g. Registration, Login) at the end', 'Add a test case heading at the end');
  document.querySelector('[data-info="date"]').placeholder = today();
  const t = await dbGet('kv', titleKey());
  $('title').value = (t && t.value) || word('User Manual', 'Test Evidence');
  document.title = word('User Manual', 'Test Evidence') + ' — EvidenceKit';
  $('empty').innerHTML = word(
    'No steps yet. Tip: group steps into sections such as “Registration” and “Login” with ＋ Section or “New section here”. Set <b>After capture → Add to Manual / Test Evidence</b> in the popup and press <b>＋ User Manual</b> after each screenshot, or record a <b>Step guide</b>.',
    'No test cases yet. Record a <b>Step guide</b> and choose <b>＋ Test Evidence</b> when it is finished (each recording becomes a test case), or set <b>After capture → Add to Manual / Test Evidence</b> and press <b>＋ Test Evidence</b> after a screenshot.');
}
const saveInfo = () => dbPut('kv', { key: 'evidenceInfo', value: { ...info } });
function tcOf(sec) {
  if (!sec.tc || typeof sec.tc !== 'object') sec.tc = {};
  return sec.tc;
}
const caseIndex = (sec) => steps.filter(isSec).indexOf(sec) + 1;
function renderSummary() {
  const box = $('evSummary');
  box.textContent = '';
  if (!isEv()) return;
  const cases = steps.filter(isSec).map((s) => ({ status: tcOf(s).status }));
  const c = countStatus(cases);
  const add = (text, cls) => box.append(Object.assign(document.createElement('span'), { className: 'chip' + (cls ? ' ' + cls : ''), textContent: text }));
  box.append(Object.assign(document.createElement('b'), { textContent: `${c.total} test case${c.total === 1 ? '' : 's'}` }));
  add(`Pass ${c.pass}`, 'pass'); add(`Fail ${c.fail}`, 'fail'); add(`Blocked ${c.blocked}`, 'blocked'); add(`Not run ${c.untested}`, 'untested');
}
function statusSelect(cls, value, onChange) {
  const sel = document.createElement('select');
  sel.className = `${cls} ${statusOf(value)}`;
  for (const [v, l] of STATUS_OPTIONS) sel.append(new Option(l, v));
  sel.value = statusOf(value);
  sel.addEventListener('change', () => { sel.className = `${cls} ${sel.value}`; onChange(sel.value); });
  return sel;
}
function area(value, placeholder, onInput) {
  const ta = document.createElement('textarea');
  ta.rows = 1;
  ta.value = value || '';
  ta.placeholder = placeholder;
  ta.addEventListener('input', () => { onInput(ta.value); autosize(ta); });
  requestAnimationFrame(() => autosize(ta));
  return ta;
}
const label = (text) => Object.assign(document.createElement('span'), { textContent: text });

function renderToc() {
  const nav = $('toc');
  nav.textContent = '';
  const count = steps.filter((s) => !isSec(s)).length;
  nav.hidden = !brand.toc || count < 2;
  if (nav.hidden) return;
  const h = document.createElement('h2');
  h.textContent = 'Contents';
  const top = document.createElement('ol');
  for (const g of groups()) {
    const stepList = document.createElement('ol');
    g.items.forEach((s, k) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#s-${s.id}`;
      a.textContent = s.title || `Step ${k + 1}`;
      li.append(a);
      stepList.append(li);
    });
    if (g.sec) {
      const li = document.createElement('li');
      li.className = 'toc-sec';
      const a = document.createElement('a');
      a.href = `#s-${g.sec.id}`;
      a.textContent = g.sec.title || 'Untitled section';
      li.append(a, stepList);
      top.append(li);
    } else g.items.length && [...stepList.children].forEach((li) => top.append(li));
  }
  nav.append(h, top);
}

// ---------------- in-page editor (annotate without leaving the manual) ----------------
let edDirty = false;
function openEditor(s, label) {
  edDirty = false;
  $('edN').textContent = label;
  $('edFrame').src = chrome.runtime.getURL(`editor/editor.html?step=${s.id}&n=${label}&embed=1`);
  $('edModal').hidden = false;
  document.body.classList.add('modal-open');
}
function closeEditor(force) {
  if (!force && edDirty && !confirm('Close without saving your changes to this step?')) return;
  $('edModal').hidden = true;
  $('edFrame').src = 'about:blank';
  document.body.classList.remove('modal-open');
}
window.addEventListener('message', async (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.type === 'evkDirty') edDirty = !!e.data.dirty;
  if (e.data.type === 'evkStepSaved') {
    edDirty = false;
    await reload(true);
    closeEditor(true);
    showOk('Step image saved', 'The picture in your manual is updated.');
  }
});

// ---------------- render ----------------
const ICONS = {
  edit: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12.4 14.6a2 2 0 0 1-.9.5l-2.9.8a.5.5 0 0 1-.6-.6l.8-2.9a2 2 0 0 1 .5-.9z"/>',
  section: '<path d="M11 12H3M16 6H3M16 18H3M18 9v6M21 12h-6"/>',
};
const svgIcon = (k) => `<svg class="bi" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;
function mkTools(tools) {
  return (label, tip, fn, dis, cls, icon) => {
    const b = document.createElement('button');
    if (icon) { b.innerHTML = svgIcon(icon) + '<span></span>'; b.lastChild.textContent = label; } else b.textContent = label;
    b.title = tip; b.disabled = !!dis;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    tools.append(b);
    return b;
  };
}

function renderSection(s, i, count) {
  const wrap = document.createElement('div');
  wrap.className = 'section';
  wrap.id = `s-${s.id}`;
  wrap.dataset.sec = s.id;
  const head = document.createElement('div');
  head.className = 'sec-head';
  const title = document.createElement('input');
  title.className = 'sec-title';
  title.placeholder = word('Section name, e.g. Registration', 'Test case, e.g. Create a new asset');
  title.value = s.title || '';
  title.addEventListener('input', () => { s.title = title.value; saveSoon(s); renderToc(); fillScope(); });
  const n = document.createElement('span');
  n.className = 'sec-count';
  n.textContent = `${count} step${count === 1 ? '' : 's'}`;
  const tools = document.createElement('div');
  tools.className = 'tools';
  const btn = mkTools(tools);
  btn('↑', 'Move this heading up', () => move(i, -1), i === 0);
  btn('↓', 'Move this heading down', () => move(i, 1), i === steps.length - 1);
  const other = mode === 'evidence' ? 'manual' : 'evidence';
  btn(`⇄ To ${DOC_NAMES[other]}`, `Move this ${word('section', 'test case')} and its ${count} step${count === 1 ? '' : 's'} to the ${DOC_NAMES[other]}`, async () => {
    const group = [s];
    for (let k = i + 1; k < steps.length && !isSec(steps[k]); k++) group.push(steps[k]);
    if (!confirm(`Move “${s.title || word('Untitled section', 'Untitled test case')}” and its ${count} step${count === 1 ? '' : 's'} to the ${DOC_NAMES[other]}?`)) return;
    for (const it of group) { it.doc = other; await dbPutIfExists('steps', it); }
    await reload(true);
    showOk(`Moved to the ${DOC_NAMES[other]}`, `${count} step${count === 1 ? '' : 's'} moved. Switch to “${DOC_NAMES[other]}” at the top to see them.`);
  });
  btn('✕ Remove heading', 'Remove only the heading — its steps join the section above', async () => {
    let cnt = 0;
    for (let k = i + 1; k < steps.length && !isSec(steps[k]); k++) cnt++;
    const above = steps.slice(0, i).some(isSec) ? 'the section above' : 'the start of the manual (no section)';
    if (!confirm(`Remove the section heading “${s.title || 'Untitled section'}”?\n\nOnly the heading is removed. ${cnt === 0 ? 'It has no steps.' : cnt === 1 ? 'Its 1 step stays and moves under' : `Its ${cnt} steps stay and move under`} ${cnt === 0 ? '' : above + '. '}Step numbers are updated.`)) return;
    cancelSaves([s.id]);
    await dbDel('steps', s.id);
    await reload(true);
  });
  head.append(title, n, tools);
  wrap.append(head);
  if (isEv()) wrap.append(...testCaseFields(s, wrap));
  return wrap;
}

// Test Evidence: the test case is written once on its heading — not on every click step
function testCaseFields(s, wrap) {
  const tc = tcOf(s);
  const save = () => saveSoon(s);
  wrap.classList.add('st-' + statusOf(tc.status));
  const row = document.createElement('div');
  row.className = 'tc-head';
  const id = Object.assign(document.createElement('input'), { className: 'tc-id', value: tc.id || '', placeholder: tcIdOf(null, caseIndex(s)), title: 'Test case ID (empty = numbered automatically)' });
  id.addEventListener('input', () => { tc.id = id.value.trim(); save(); });
  const st = statusSelect('tc-status', tc.status, (v) => {
    tc.status = v;
    wrap.className = wrap.className.replace(/\bst-\w+/g, '').trim() + ' st-' + v;
    save();
    renderSummary();
  });
  st.title = 'Result of this test case';
  const bug = Object.assign(document.createElement('input'), { className: 'tc-bug', value: tc.bug || '', placeholder: 'Bug ID (if failed)' });
  bug.addEventListener('input', () => { tc.bug = bug.value; save(); });
  row.append(id, st, bug);
  const grid = document.createElement('div');
  grid.className = 'tc-fields';
  grid.append(
    label('Precondition'), area(tc.pre, 'e.g. User is logged in as Asset Manager', (v) => { tc.pre = v; save(); }),
    label('Expected result'), area(tc.expected, 'What should happen, e.g. The asset is saved and appears in the asset list', (v) => { tc.expected = v; save(); }),
    label('Actual result'), area(tc.actual, 'What really happened (empty + Pass = “As expected.”)', (v) => { tc.actual = v; save(); }),
  );
  return [row, grid];
}

// Test Evidence: a step only gets its own expected / actual when it is marked as a checkpoint
function checkpointFields(s) {
  const box = document.createElement('div');
  box.className = 'ck';
  box.hidden = !s.check;
  const save = () => saveSoon(s);
  const st = statusSelect('ck-status', s.status, (v) => { s.status = v; save(); });
  box.append(
    label('Checkpoint'), st,
    label('Expected'), area(s.expected, 'What this step should show', (v) => { s.expected = v; save(); }),
    label('Actual'), area(s.actual, 'What it showed (empty + Pass = “As expected.”)', (v) => { s.actual = v; save(); }),
  );
  return box;
}

function renderStep(s, i, n) {
  const wrap = document.createElement('div');
  wrap.className = 'step';
  wrap.id = `s-${s.id}`;

  const head = document.createElement('div');
  head.className = 'step-head';
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = `Step ${n}`;
  const title = document.createElement('input');
  title.className = 'step-title';
  title.placeholder = 'Step title (e.g. Click “Save” button)';
  title.value = s.title || '';
  title.addEventListener('input', () => { s.title = title.value; saveSoon(s); renderToc(); });

  const tools = document.createElement('div');
  tools.className = 'tools';
  const btn = mkTools(tools);
  const desc = document.createElement('textarea');
  btn('✨', 'Suggest a title and description', () => {
    const sg = suggest(s, prevStep(i));
    s.title = sg.title;
    if (!s.desc) s.desc = sg.desc;
    title.value = s.title; desc.value = s.desc; autosize(desc);
    saveSoon(s); renderToc();
  });
  btn(word('New section here', 'New test case here'), word('Start a new section (e.g. “Login”) with this step', 'Start a new test case with this step'), () => addSection(i, ''), false, 'secbtn', 'section');
  let ck = null;
  if (isEv()) {
    ck = checkpointFields(s);
    const cb = btn(s.check ? '◎ Checkpoint ✓' : '◎ Checkpoint', 'Verify something at this step: give it its own expected / actual result and Pass / Fail', () => {
      s.check = !s.check;
      ck.hidden = !s.check;
      cb.textContent = s.check ? '◎ Checkpoint ✓' : '◎ Checkpoint';
      cb.classList.toggle('on', s.check);
      saveSoon(s);
    }, false, 'ckbtn' + (s.check ? ' on' : ''));
  }
  btn('↑', 'Move up', () => move(i, -1), i === 0);
  btn('↓', 'Move down', () => move(i, 1), i === steps.length - 1);
  if (s.blob) btn('Edit image', 'Edit this image: arrows, boxes, text, blur, stamps …', () => openEditor(s, n), false, 'editbtn', 'edit');
  btn('🗑', 'Delete step', async () => {
    let secName = '';
    for (let k = i - 1; k >= 0; k--) if (isSec(steps[k])) { secName = steps[k].title || 'Untitled section'; break; }
    const what = `Step ${n}${secName ? ` of the section “${secName}”` : ''}`;
    if (!confirm(`Delete ${what}${s.title ? `:\n${s.title}` : ''}\n\nIts picture and text are removed for good — this cannot be undone. The steps after it are renumbered automatically.`)) return;
    cancelSaves([s.id]);
    await dbDel('steps', s.id);
    await reload(true);
  }, false, 'danger');
  head.append(num, title, tools);

  desc.className = 'step-desc';
  desc.placeholder = 'Describe what the user should do in this step…';
  desc.rows = 1;
  desc.value = s.desc || '';
  desc.addEventListener('input', () => { s.desc = desc.value; autosize(desc); saveSoon(s); });

  wrap.append(head, desc);
  if (ck) wrap.append(ck);
  if (s.blob) {
    const img = document.createElement('img');
    const u = URL.createObjectURL(s.blob);
    urls.push(u);
    img.src = u;
    img.alt = `Step ${n}`;
    img.addEventListener('dblclick', () => openEditor(s, n));
    wrap.append(img);
  }
  requestAnimationFrame(() => autosize(desc));
  return wrap;
}

function render() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  const box = $('steps');
  box.textContent = '';
  const stepCount = steps.filter((s) => !isSec(s)).length;
  const secCount = steps.length - stepCount;
  $('empty').style.display = steps.length ? 'none' : 'block';
  if (isEv() && steps.length && !isSec(steps[0])) {
    box.append(Object.assign(document.createElement('div'), {
      className: 'loose-note',
      textContent: 'The first steps below are not in a test case yet. Press “New test case here” on the first of them to make them one test case.',
    }));
  }
  // numbering starts again at 1 in every section
  let n = 0;
  const numbered = [];
  steps.forEach((s, i) => {
    if (isSec(s)) {
      n = 0;
      let count = 0;
      for (let k = i + 1; k < steps.length && !isSec(steps[k]); k++) count++;
      box.append(renderSection(s, i, count));
    } else { box.append(renderStep(s, i, ++n)); numbered.push([s, n]); }
  });
  const sw = word('section', 'test case');
  $('meta').textContent = `${stepCount} step${stepCount === 1 ? '' : 's'}${secCount ? ` in ${secCount} ${sw}${secCount === 1 ? '' : 's'}` : ''} • Created ${nowText()}`;
  renderSummary();
  renderToc();
  fillScope();
  syncNumbers(numbered);
}

// Redraw the click numbers on step pictures so they always match the Step numbers shown here.
let syncP = Promise.resolve();
let syncGen = 0; // raised by Clear all: a redraw still running stops at once
function syncNumbers(list) {
  const gen = syncGen;
  syncP = syncP.then(async () => {
    let changed = false;
    for (const [s, n] of list) {
      if (gen !== syncGen) return;
      try {
        if (await syncNumber(s, n)) {
          await dbPutIfExists('steps', s);
          changed = true;
          const img = document.querySelector(`#s-${s.id} img`);
          if (img) { const u = URL.createObjectURL(s.blob); urls.push(u); img.src = u; }
        }
      } catch (e) { console.error('renumber failed', e); }
    }
    if (changed) signature = mode + '|' + sigOf(steps);
  });
  return syncP;
}

// export scope: whole manual or one section
function fillScope() {
  const sel = $('expScope');
  const cur = sel.value;
  sel.textContent = '';
  sel.append(new Option(word('Whole manual', 'All test cases'), 'all'));
  steps.filter(isSec).forEach((s) => sel.append(new Option(isEv()
    ? `${tcIdOf(tcOf(s), caseIndex(s))}: ${s.title || 'Untitled test case'}`
    : `Section: ${s.title || 'Untitled section'}`, s.id)));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'all';
  sel.parentElement.hidden = !steps.some(isSec);
}

// ---------------- Step guide recordings waiting for "Add to …" ----------------
let waitingSig = '';
async function renderWaiting() {
  let list = [];
  let live = null;
  try { list = await pendingBatches(); } catch (e) {}
  try {
    const g = await chrome.runtime.sendMessage({ type: 'guideStatus' });
    if (g && g.guide && g.guide.active) live = g.guide.batch;
  } catch (e) {}
  const sig = list.map((w) => `${w.batch}:${w.items.length}`).join('|') + '#' + live;
  if (sig === waitingSig) return;
  waitingSig = sig;
  const box = $('waiting');
  box.textContent = '';
  box.hidden = !list.length;
  for (const w of list) {
    const rec = w.batch === live;
    const row = document.createElement('div');
    row.className = 'wrow' + (rec ? ' live' : '');
    const txt = document.createElement('div');
    txt.className = 'wt';
    txt.append(Object.assign(document.createElement('b'), { textContent: w.title }),
      Object.assign(document.createElement('small'), {
        textContent: rec ? `${w.steps} step${w.steps === 1 ? '' : 's'} so far — still recording. Finish the Step guide first.`
          : `${w.steps} recorded step${w.steps === 1 ? '' : 's'} waiting. Where should they go?`,
      }));
    row.append(txt);
    const btn = (label, targets, cls) => {
      const b = Object.assign(document.createElement('button'), { textContent: label, disabled: rec });
      if (cls) b.className = cls;
      b.addEventListener('click', async () => {
        if (!targets.length && !confirm(`Throw away “${w.title}” and its ${w.steps} step${w.steps === 1 ? '' : 's'}?`)) return;
        row.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        await resolveBatch(w.batch, targets);
        waitingSig = '';
        if (targets.length === 1 && targets[0] !== mode) await setActiveDoc(targets[0]); // show where it went
        await reload(true);
        if (!targets.length) toast('Recording discarded');
        else if (targets.length === 2) toast(`Added to both — switch at the top to see the ${DOC_NAMES[mode === 'manual' ? 'evidence' : 'manual']}`, 4000);
      });
      row.append(b);
    };
    btn('＋ User Manual', ['manual'], 'primary');
    btn('＋ Test Evidence', ['evidence'], 'ev');
    btn('Both', ['manual', 'evidence']);
    btn('Discard', [], 'danger');
    box.append(row);
  }
}

async function reload(force) {
  renderWaiting();
  // the document shown here may have been switched (e.g. "Open Test Evidence" after adding something)
  const want = await activeDoc();
  if (want !== mode) { await loadDocState(); force = true; }
  const all = await getSteps();
  const list = all.filter((s) => docOf(s) === mode); // only this document (User Manual or Test Evidence)
  const sig = mode + '|' + sigOf(list);
  if (!force && sig === signature) return;
  steps = list;
  signature = sig;
  if (await applySuggestions(false)) signature = mode + '|' + sigOf(steps);
  render();
  // anything added since the last time this page looked is shown clearly
  const fresh = steps.filter((s) => !isSec(s) && !known.has(s.id));
  all.forEach((s) => known.add(s.id)); // also the other document's, so switching does not flag them as new
  if (knownReady && fresh.length) {
    fresh.forEach((s) => {
      const el = document.getElementById(`s-${s.id}`);
      if (el) { el.classList.add('is-new'); setTimeout(() => el.classList.remove('is-new'), 9000); }
    });
    const first = document.getElementById(`s-${fresh[0].id}`);
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    showOk(fresh.length === 1 ? 'New step added' : `${fresh.length} new steps added`, 'Highlighted in green below. Add a title and description if you like.');
  }
  knownReady = true;
}
const known = new Set();
let knownReady = false;

// ---------------- adding images ----------------
async function addImageBlob(blob) {
  const all = await getSteps();
  const order = all.reduce((m, s) => Math.max(m, s.order), 0) + 1;
  await dbPut('steps', { id: uid(), order, doc: mode, blob, title: '', desc: '', url: '', ts: Date.now() });
}
$('addFile').addEventListener('change', async (e) => {
  for (const f of e.target.files) await addImageBlob(f);
  e.target.value = '';
  await reload(true);
});
document.addEventListener('paste', async (e) => {
  if (!$('edModal').hidden) return;
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
  if (!items.length) return;
  for (const it of items) await addImageBlob(it.getAsFile());
  await reload(true);
  toast('Pasted image added as a new step');
});

// ---------------- export ----------------
// -> { title, groups: [{ title|null, items: [{ n, title, desc, blob, dataUrl }] }], logo }
// dataUrls = false: only the picture Blobs (the Word export does not need the text form)
async function collect(dataUrls = true) {
  await syncP; // make sure every step picture shows its current number
  const scope = $('expScope').value || 'all';
  const docTitle = $('title').value.trim() || 'User Manual';
  let gs = groups();
  if (scope !== 'all') gs = gs.filter((g) => g.sec && g.sec.id === scope);
  const out = [];
  for (const g of gs) {
    const items = [];
    for (let k = 0; k < g.items.length; k++) {
      const s = g.items[k];
      items.push({ n: k + 1, title: s.title || '', desc: s.desc || '', blob: s.blob || null, dataUrl: s.blob && dataUrls ? await blobToDataUrl(s.blob) : '' });
    }
    out.push({ title: g.sec ? g.sec.title || 'Untitled section' : null, items });
  }
  const logo = brand.logo && dataUrls ? await blobToDataUrl(brand.logo) : '';
  const title = scope === 'all' || !out[0] ? docTitle : `${docTitle} — ${out[0].title}`;
  return { title, groups: out, logo, count: out.reduce((a, g) => a + g.items.length, 0) };
}

function buildHtml(title, gs, logo) {
  const c = brand.color;
  const anchor = (gi, n) => `g${gi + 1}-step-${n}`;
  const total = gs.reduce((a, g) => a + g.items.length, 0);
  const toc = brand.toc && total > 1
    ? `<div class="toc"><h2>Contents</h2><ol>${gs.map((g, gi) => {
      const list = g.items.map((it) => `<li><a href="#${anchor(gi, it.n)}">${esc(it.title || 'Step ' + it.n)}</a></li>`).join('');
      return g.title ? `<li><a href="#sec-${gi + 1}"><b>${esc(g.title)}</b></a><ol>${list}</ol></li>` : list;
    }).join('')}</ol></div>`
    : '';
  const body = gs.map((g, gi) => `${g.title ? `<h2 class="sec" id="sec-${gi + 1}">${esc(g.title)}</h2>` : ''}${g.items
    .map((it) => `<div class="step" id="${anchor(gi, it.n)}"><h3><span class="n">Step ${it.n}</span>${it.title ? ' ' + esc(it.title) : ''}</h3>${
      it.desc ? `<p>${esc(it.desc).replace(/\n/g, '<br>')}</p>` : ''
    }${it.dataUrl ? `<img src="${it.dataUrl}" alt="Step ${it.n}">` : ''}</div>`)
    .join('\n')}`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{font-family:Arial,Helvetica,sans-serif;max-width:860px;margin:30px auto;padding:0 16px;color:#111827;line-height:1.5}
.head{display:flex;align-items:center;gap:14px;border-bottom:3px solid ${c};padding-bottom:8px}.head img{max-height:56px;max-width:180px}
h1{margin:0;color:#111827}.meta{color:#6b7280;font-size:12px;margin-top:6px}
.toc{background:#f9fafb;border-left:4px solid ${c};padding:8px 18px;margin:18px 0}.toc h2{font-size:15px;margin:6px 0}.toc a{color:${c};text-decoration:none}.toc ol ol{margin:2px 0 6px}
h2.sec{font-size:22px;color:${c};border-bottom:2px solid ${c};padding-bottom:4px;margin:36px 0 8px;page-break-before:auto}
.step{margin:22px 0;page-break-inside:avoid}h3{font-size:17px;margin-bottom:6px}.n{background:${c};color:#fff;padding:2px 9px;border-radius:5px;margin-right:6px}
img{max-width:100%;border:1px solid #d1d5db}
</style></head><body><div class="head">${logo ? `<img src="${logo}" alt="">` : ''}<h1>${esc(title)}</h1></div><div class="meta">${total} steps${gs.some((g) => g.title) ? ` • ${gs.filter((g) => g.title).length} sections` : ''} • ${esc(nowText())}</div>${toc}${body}</body></html>`;
}

// ---------------- Test Evidence export ----------------
// -> the document for evidence-export.js; which step pictures go in depends on "Screenshots" (all / key / none)
async function collectEvidence(dataUrls = true) {
  await syncP;
  const scope = $('expScope').value || 'all';
  const shots = $('shotScope').value || 'all';
  let gs = groups();
  if (scope !== 'all') gs = gs.filter((g) => g.sec && g.sec.id === scope);
  const cases = [];
  for (const g of gs) {
    const list = [];
    for (let k = 0; k < g.items.length; k++) {
      const s = g.items[k];
      const keep = !!s.blob && (shots === 'all' || (shots === 'key' && (s.check || k === g.items.length - 1)));
      list.push({
        n: k + 1, title: s.title || '', desc: s.desc || '', check: !!s.check, status: s.status, expected: s.expected || '', actual: s.actual || '',
        blob: keep ? s.blob : null, dataUrl: keep && dataUrls ? await blobToDataUrl(s.blob) : '',
      });
    }
    if (g.sec) {
      const tc = tcOf(g.sec);
      cases.push({ tcId: tcIdOf(tc, caseIndex(g.sec)), title: g.sec.title || '', status: tc.status, bug: tc.bug || '', pre: tc.pre || '', expected: tc.expected || '', actual: tc.actual || '', steps: list });
    } else cases.push({ loose: true, tcId: '', steps: list });
  }
  const docTitle = $('title').value.trim() || 'Test Evidence';
  const one = scope !== 'all' && cases[0] && !cases[0].loose ? cases[0] : null;
  return {
    title: one ? `${docTitle} — ${one.tcId} ${one.title}`.trim() : docTitle,
    color: brand.color,
    logo: brand.logo && dataUrls ? await blobToDataUrl(brand.logo) : '',
    info: { ...info, date: info.date || today() },
    metaLine: `Generated ${nowText()} with EvidenceKit`,
    cases,
  };
}
// print an HTML document (PDF): through a hidden frame, so the evidence looks the same as the HTML / Word export
function printHtml(html, title) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  f.srcdoc = html;
  f.onload = () => {
    const old = document.title;
    document.title = title;
    f.contentWindow.focus();
    f.contentWindow.print();
    document.title = old;
    setTimeout(() => f.remove(), 1000);
  };
  document.body.append(f);
}
async function exportEvidence(kind) {
  const doc = await collectEvidence();
  if (!doc.cases.length) return toast('No test cases to export');
  const name = slug(doc.title);
  if (kind === 'pdf') return printHtml(buildEvidenceHtml(doc, false), doc.title);
  if (kind === 'html') return download(new Blob([buildEvidenceHtml(doc, false)], { type: 'text/html' }), name + '.html');
  const logo = brand.logo ? { path: `images/logo.${/jpe?g/.test(brand.logo.type) ? 'jpg' : /svg/.test(brand.logo.type) ? 'svg' : 'png'}`, blob: brand.logo } : null;
  const { md, files } = buildEvidenceMd(doc, logo);
  const zip = new JSZip();
  files.forEach((f) => zip.file(f.path, f.blob));
  zip.file('test-evidence.md', md);
  download(await zip.generateAsync({ type: 'blob' }), name + '.zip');
}

// Word (.docx): a real Word document with the pictures inside (the main export)
let docxBusy = false;
async function exportDocx() {
  if (docxBusy) return;
  docxBusy = true;
  const btn = $('expDocx');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Making Word file…';
  try {
    let blob, title;
    if (isEv()) {
      const doc = await collectEvidence(false);
      if (!doc.cases.length) return toast('No test cases to export');
      ({ title } = doc);
      blob = await evidenceDocx(doc, brand.logo);
    } else {
      const c = await collect(false);
      if (!c.count) return toast('No steps to export');
      title = c.title;
      const secs = c.groups.filter((g) => g.title).length;
      blob = await manualDocx({
        title, color: brand.color, logo: brand.logo, toc: brand.toc, groups: c.groups,
        metaLine: `${c.count} step${c.count === 1 ? '' : 's'}${secs ? ` • ${secs} section${secs === 1 ? '' : 's'}` : ''} • ${nowText()}`,
      });
    }
    const name = slug(title) + '.docx';
    download(blob, name);
    showOk('Word file saved', `${name} (${(blob.size / 1048576).toFixed(1)} MB) — in your Downloads folder.`);
  } catch (e) {
    console.error(e);
    alert('Could not make the Word file: ' + e.message);
  } finally {
    docxBusy = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}

function bindExport() {
  $('expPdf').addEventListener('click', () => {
    if (isEv()) return exportEvidence('pdf');
    const scope = $('expScope').value || 'all';
    document.title = $('title').value || 'User Manual';
    // print only the chosen section
    const hide = [];
    if (scope !== 'all') {
      let inScope = false;
      for (const el of $('steps').children) {
        if (el.classList.contains('section')) inScope = el.dataset.sec === scope;
        if (!inScope) { el.classList.add('noprint'); hide.push(el); }
      }
      $('toc').classList.add('noprint'); hide.push($('toc'));
    }
    window.print();
    hide.forEach((el) => el.classList.remove('noprint'));
  });
  $('expHtml').addEventListener('click', async () => {
    if (isEv()) return exportEvidence('html');
    const { title, groups: gs, logo, count } = await collect();
    if (!count) return toast('No steps to export');
    download(new Blob([buildHtml(title, gs, logo, false)], { type: 'text/html' }), slug(title) + '.html');
  });
  $('expDocx').addEventListener('click', exportDocx);
  $('expMd').addEventListener('click', async () => {
    if (isEv()) return exportEvidence('md');
    const { title, groups: gs, count } = await collect();
    if (!count) return toast('No steps to export');
    const zip = new JSZip();
    let md = '';
    if (brand.logo) { zip.file('images/logo.png', brand.logo); md += '![logo](images/logo.png)\n\n'; }
    md += `# ${title}\n\n`;
    if (brand.toc && count > 1) {
      md += '## Contents\n\n';
      gs.forEach((g, gi) => {
        const list = g.items.map((it) => `${g.title ? '   ' : ''}${it.n}. [${it.title || 'Step ' + it.n}](#g${gi + 1}-step-${it.n})`).join('\n');
        md += g.title ? `${gi + 1}. [${g.title}](#sec-${gi + 1})\n${list}\n` : `${list}\n`;
      });
      md += '\n';
    }
    let img = 0;
    gs.forEach((g, gi) => {
      if (g.title) md += `<a id="sec-${gi + 1}"></a>\n\n## ${g.title}\n\n`;
      for (const it of g.items) {
        md += `<a id="g${gi + 1}-step-${it.n}"></a>\n\n### Step ${it.n}${it.title ? ': ' + it.title : ''}\n\n`;
        if (it.desc) md += `${it.desc}\n\n`;
        if (it.blob) {
          const f = `images/${String(++img).padStart(3, '0')}-step-${it.n}.png`;
          md += `![Step ${it.n}](${f})\n\n`;
          zip.file(f, it.blob);
        }
      }
    });
    zip.file('manual.md', md);
    download(await zip.generateAsync({ type: 'blob' }), slug(title) + '.zip');
  });
  $('clearAll').addEventListener('click', async () => {
    // only this document: the other one (User Manual / Test Evidence) is kept
    const name = DOC_NAMES[mode];
    if (!steps.length || !confirm(`Delete ALL ${steps.filter((x) => !isSec(x)).length} steps and ${steps.filter(isSec).length} ${word('section headings', 'test cases')} of the ${name}?\n\nThe ${DOC_NAMES[mode === 'evidence' ? 'manual' : 'evidence']} is not touched. This cannot be undone.`)) return;
    // stop everything that could still write a step (typing saves, number redraws), then delete what the
    // database holds right now for this document (also steps added since the page last looked) in one go
    cancelSaves();
    syncGen++;
    await syncP.catch(() => {});
    const ids = (await getSteps()).filter((s) => docOf(s) === mode).map((s) => s.id);
    await dbDelMany('steps', ids);
    await reload(true);
    showOk(`${DOC_NAMES[mode]} cleared`, `${ids.length} item${ids.length === 1 ? '' : 's'} deleted.`);
  });
}

function bindBrand() {
  $('brandColor').addEventListener('input', () => { brand.color = $('brandColor').value; document.body.style.setProperty('--brand', brand.color); });
  $('brandColor').addEventListener('change', saveBrand);
  $('tocOn').addEventListener('change', () => { brand.toc = $('tocOn').checked; saveBrand(); renderToc(); });
  $('logoFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 2 * 1048576) return toast('Logo must be smaller than 2 MB');
    brand.logo = f;
    await saveBrand();
    applyBrand();
  });
  $('logoDel').addEventListener('click', async () => { brand.logo = null; await saveBrand(); applyBrand(); });
  $('addSection').addEventListener('click', () => addSection(null, ''));
  $('suggestAll').addEventListener('click', async () => {
    const real = steps.filter((s) => !isSec(s));
    if (!real.length) return toast('No steps yet');
    let list = real.filter((s) => !s.title);
    if (!list.length) {
      if (!confirm('Every step already has a title.\n\nReplace all of them with new automatic suggestions? Titles you typed yourself will be overwritten.')) return;
      list = real;
    }
    for (const s of list) {
      const sg = suggest(s, prevStep(steps.indexOf(s)));
      s.title = sg.title;
      if (!s.desc) s.desc = sg.desc;
      s.sugDone = true;
      await dbPutIfExists('steps', s);
    }
    await reload(true);
    toast(`Suggested ${list.length} title${list.length === 1 ? '' : 's'}`);
  });
  $('edClose').addEventListener('click', () => closeEditor(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('edModal').hidden) closeEditor(false); });
}

// ---------------- backup / restore ----------------
let pendingRestore = null;
function bindBackup() {
  $('backupBtn').addEventListener('click', async () => {
    try {
      const items = await getSteps();
      if (!items.length && !confirm('The manual is empty. Make a backup anyway?')) return;
      const kv = {};
      for (const k of KV_KEYS) { const r = await dbGet('kv', k); if (r) kv[k] = r.value; }
      const { settings } = await chrome.storage.local.get('settings');
      toast('Preparing the backup…', 4000);
      const blob = await makeBackup({ items, kv, settings, appVersion: chrome.runtime.getManifest().version });
      const name = `EvidenceKit-backup_${fileStamp(Date.now())}.zip`;
      download(blob, name);
      const n = items.filter((s) => !isSec(s)).length;
      showOk('Backup saved', `${n} step${n === 1 ? '' : 's'}, ${items.length - n} section${items.length - n === 1 ? '' : 's'} / test cases and all pictures → ${name} (${(blob.size / 1048576).toFixed(1)} MB)`);
    } catch (e) {
      alert('Backup failed: ' + e.message);
    }
  });
  $('restoreFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { pendingRestore = await readBackup(f); } catch (err) { return alert('Could not restore: ' + err.message); }
    const b = pendingRestore;
    const curAll = (await getSteps()).filter((s) => !isSec(s)).length;
    const when = b.exportedAt ? fmtTime(Date.parse(b.exportedAt), { timeFormat: '12', dateFormat: 'DD MMM YYYY', showTz: false }) : 'an unknown date';
    $('restoreInfo').textContent = `Backup from ${when}: ${b.steps} step${b.steps === 1 ? '' : 's'} in ${b.sections} section${b.sections === 1 ? '' : 's'} / test case${b.sections === 1 ? '' : 's'}.\n\n`
      + perDoc(b.items) + '\n\n'
      + `Replace — everything now in the User Manual and the Test Evidence (${curAll} step${curAll === 1 ? '' : 's'}) is deleted; the backup takes its place, with its title, logo, colour and evidence details.\n`
      + 'Add — the backup’s steps go after the current ones, each into its own document (User Manual or Test Evidence).';
    $('restoreSettings').checked = false;
    $('restoreSettings').parentElement.hidden = !b.settings;
    $('restoreDlg').showModal();
  });
  $('restoreCancel').addEventListener('click', () => { pendingRestore = null; $('restoreDlg').close(); });
  $('restoreDlg').addEventListener('close', () => { pendingRestore = null; });
  $('restoreReplace').addEventListener('click', async () => {
    const cur = (await getSteps()).filter((s) => !isSec(s)).length;
    if (cur && !confirm(`Delete all ${cur} step${cur === 1 ? '' : 's'} of the User Manual and the Test Evidence and replace them with the backup?\n\nThis cannot be undone (make a Backup first if you are not sure).`)) return;
    applyRestore('replace');
  });
  $('restoreAdd').addEventListener('click', () => applyRestore('add'));
}
// "User Manual: 5 steps in 2 sections · Test Evidence: 3 steps in 1 test case"
function perDoc(items) {
  return ['manual', 'evidence'].map((d) => {
    const mine = items.filter((s) => docOf(s) === d);
    const n = mine.filter((s) => !isSec(s)).length, sec = mine.length - n;
    const sw = d === 'evidence' ? 'test case' : 'section';
    return `${DOC_NAMES[d]}: ${n} step${n === 1 ? '' : 's'}${sec ? ` in ${sec} ${sw}${sec === 1 ? '' : 's'}` : ''}`;
  }).join('  ·  ');
}
async function applyRestore(how) {
  const b = pendingRestore;
  const withSettings = $('restoreSettings').checked;
  $('restoreDlg').close();
  if (!b) return;
  try {
    if (how === 'replace') {
      cancelSaves();
      syncGen++;
      await syncP.catch(() => {});
      await dbClear('steps');
      for (const s of b.items) { const { type, ...rest } = s; await dbPut('steps', type ? { ...rest, type } : rest); known.add(s.id); }
      for (const k of KV_KEYS) {
        if (b.kv[k] !== undefined) await dbPut('kv', { key: k, value: b.kv[k] });
        else await dbDel('kv', k);
      }
    } else {
      const all = await getSteps();
      let order = all.reduce((m, s) => Math.max(m, s.order), 0);
      // a backup made before User Manual and Test Evidence were separate has no doc: it goes to the one shown now
      const legacy = !b.items.some((s) => s.doc);
      for (const s of [...b.items].sort((x, y) => x.order - y.order)) {
        const { type, ...rest } = s;
        await dbPut('steps', { ...rest, ...(type ? { type } : {}), doc: legacy ? mode : docOf(s), id: uid(), order: ++order });
      }
    }
    if (withSettings && b.settings) {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings || {}), ...b.settings } });
    }
    if (how === 'replace') { await loadDocState(); await loadBrand(); }
    await reload(true);
    showOk('Backup restored', `${b.steps} step${b.steps === 1 ? '' : 's'} and ${b.sections} section${b.sections === 1 ? '' : 's'} / test cases ${how === 'replace' ? 'restored' : 'added'}${withSettings && b.settings ? ', settings restored' : ''}.`);
  } catch (e) {
    alert('Restore failed: ' + e.message);
  }
}

function bindMode() {
  document.querySelectorAll('.modeseg button').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    await setActiveDoc(mode); // remembered: the page opens on this document next time
    await applyMode();
    await reload(true);
  }));
  document.querySelectorAll('[data-info]').forEach((el) => el.addEventListener('input', () => { info[el.dataset.info] = el.value; saveInfo(); }));
  $('shotScope').addEventListener('change', () => { info.shots = $('shotScope').value; saveInfo(); });
}

async function init() {
  $('title').addEventListener('input', () => dbPut('kv', { key: titleKey(), value: $('title').value }));
  bindExport();
  bindBrand();
  bindBackup();
  bindMode();
  await loadDocState();
  await reload(true);
  await loadBrand();
  window.addEventListener('focus', () => reload(false));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reload(false); });
}
init();
