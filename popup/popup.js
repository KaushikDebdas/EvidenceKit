import { DEFAULT_SETTINGS, dtChips, dtFromChips } from '../lib/compose.js';
import { dbAll } from '../lib/db.js';
import { docOf } from '../lib/docs.js';

// the book button: steps in the User Manual / Test Evidence, and step-guide recordings still waiting for a choice
async function renderDocs() {
  try {
    const all = await dbAll('steps');
    const n = (d) => all.filter((x) => x.type !== 'section' && docOf(x) === d).length;
    const waiting = n('pending');
    const dot = $('stepCount');
    dot.textContent = waiting ? '!' : '';
    dot.classList.toggle('wait', !!waiting);
    $('manual').title = `User Manual: ${n('manual')} steps · Test Evidence: ${n('evidence')} steps`
      + (waiting ? `
${waiting} recorded steps are waiting — open to choose where they go` : '');
  } catch (e) {}
}

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };
let tabId = null;
let guideActive = false;
let lastStatus = null;

function showErr(msg) {
  const e = $('err');
  e.textContent = msg || '';
  e.style.display = msg ? 'block' : 'none';
}

async function send(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (r && r.ok === false) throw new Error(r.error);
  return r;
}
const save = () => chrome.storage.local.set({ settings });

const RESTRICTED = /^(chrome|chrome-extension|edge|about|devtools|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

function segment(id, attr, value, onPick) {
  const seg = $(id);
  const mark = (v) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset[attr] === String(v)));
  mark(value);
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { mark(b.dataset[attr]); onPick(b.dataset[attr]); }));
}

function bindSettings() {
  for (const k of ['url', 'consoleInImg', 'networkInImg', 'logErrorsOnly']) {
    $(k).checked = !!settings[k];
    $(k).addEventListener('change', () => { settings[k] = $(k).checked; save(); });
  }
  const dt = dtChips(settings);
  $('dDate').checked = dt.date;
  $('dTime').checked = dt.time;
  const onDt = () => { Object.assign(settings, dtFromChips($('dDate').checked, $('dTime').checked)); save(); };
  $('dDate').addEventListener('change', onDt);
  $('dTime').addEventListener('change', onDt);
  $('afterAction').value = settings.afterAction;
  $('afterAction').addEventListener('change', () => { settings.afterAction = $('afterAction').value; save(); });
  segment('delaySeg', 'd', +settings.captureDelay || 0, (v) => { settings.captureDelay = +v; save(); });
}

function renderStatus(st) {
  lastStatus = st;
  const text = $('logText');
  text.textContent = '';
  const reload = $('logReload');
  if (!settings.autoLogs) {
    text.textContent = 'Log capture is off (Settings → Logs)';
    reload.style.display = 'none';
  } else if (!st.hooked) {
    text.textContent = 'Reload this tab to start capturing logs';
    reload.style.display = '';
  } else {
    reload.style.display = 'none';
    const add = (t, cls) => { const s = document.createElement('span'); s.textContent = t; if (cls) s.className = cls; text.append(s); };
    add(`Console ${st.console}`);
    if (st.errors) add(` (${st.errors} errors)`, 'bad');
    add(`  ·  Network ${st.network}`);
    if (st.failed) add(` (${st.failed} failed)`, 'bad');
  }
}

async function refresh() {
  if (tabId == null) return;
  try {
    const r = await send({ type: 'logStatus', tabId });
    renderStatus(r.status);
  } catch (e) {}
  try {
    const g = await send({ type: 'guideStatus' });
    guideActive = !!g.guide.active;
    $('guideText').textContent = guideActive ? 'Stop guide' : 'Step guide';
    $('guideSub').textContent = guideActive ? `${g.guide.count} steps recorded` : 'Each click becomes a step';
    $('guide').classList.toggle('on', guideActive);
  } catch (e) {}
}

async function activeUrl() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return (t && t.url) || '';
}

async function capture(mode, extra = {}) {
  showErr('');
  try {
    if (mode !== 'split' && RESTRICTED.test(await activeUrl())) return showErr('Chrome blocks capture on this page. Open a normal website tab.');
    await save();
    const delay = mode === 'split' ? 0 : +settings.captureDelay || 0;
    await send({ type: 'capture', mode, delay, ...extra }); // answered at once; the capture runs after the popup closes
    window.close();
  } catch (e) { showErr(e.message); }
}

document.querySelectorAll('[data-cap]').forEach((b) => b.addEventListener('click', () => capture(b.dataset.cap)));

// ---------- split view: tick 2–6 tabs from any window ----------
let splitLayout = settings.splitLayout;
const picked = new Set();

async function renderTabs() {
  const list = $('tabList');
  list.textContent = '';
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const multi = wins.length > 1;
  // ticked from the start: your current tab, plus the current tab of every other open window
  picked.clear();
  const cur = await chrome.windows.getLastFocused().catch(() => null);
  const ordered = cur ? [...wins.filter((w) => w.id === cur.id), ...wins.filter((w) => w.id !== cur.id)] : wins;
  for (const w of ordered) {
    if (w.state === 'minimized') continue;
    const t = (w.tabs || []).find((x) => x.active);
    if (t && !RESTRICTED.test(t.url || '') && picked.size < 6) picked.add(t.id);
  }
  wins.forEach((w, wi) => (w.tabs || []).forEach((t) => list.append(tabRow(t, multi ? `Window ${wi + 1}` : '', true))));
  updateGo();
}
function tabRow(t, note, selectable) {
  const row = document.createElement('label');
  row.className = 'trow';
  const bad = RESTRICTED.test(t.url || '');
  if (bad) row.classList.add('dis');
  if (selectable) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = bad;
    cb.checked = picked.has(t.id);
    cb.addEventListener('change', () => {
      if (cb.checked) { if (picked.size >= 6) { cb.checked = false; return; } picked.add(t.id); } else picked.delete(t.id);
      updateGo();
    });
    row.append(cb);
  }
  if (t.favIconUrl && /^https?:|^data:/.test(t.favIconUrl)) {
    const img = document.createElement('img');
    img.src = t.favIconUrl;
    img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'fav' }));
    row.append(img);
  } else row.append(Object.assign(document.createElement('span'), { className: 'fav' }));
  const tt = document.createElement('span');
  tt.className = 'tt';
  tt.textContent = t.title || t.url;
  tt.title = t.url || '';
  row.append(tt);
  if (note || bad) row.append(Object.assign(document.createElement('span'), { className: 'wn', textContent: bad ? 'not allowed' : note }));
  return row;
}
function updateGo() {
  $('splitGo').disabled = picked.size < 2;
  $('splitGo').textContent = picked.size >= 2 ? `Capture ${picked.size} tabs side by side` : 'Tick at least 2 tabs';
}

function openSplit() {
  $('home').hidden = true;
  $('split').hidden = false;
  splitLayout = settings.splitLayout || 'auto';
  $('splitFull').checked = !!settings.splitFull;
  segment('laySeg', 'l', splitLayout, (v) => { splitLayout = v; settings.splitLayout = v; save(); });
  renderTabs();
}
$('splitBtn').addEventListener('click', openSplit);
$('splitBack').addEventListener('click', () => { $('split').hidden = true; $('home').hidden = false; });
$('splitFull').addEventListener('change', () => { settings.splitFull = $('splitFull').checked; save(); });
$('splitGo').addEventListener('click', async () => {
  showErr('');
  const extra = { layout: splitLayout, full: $('splitFull').checked, tabIds: [...picked] };
  try {
    await save();
    await send({ type: 'capture', mode: 'split', ...extra });
    window.close();
  } catch (e) {
    $('split').hidden = true; $('home').hidden = false;
    showErr(e.message);
  }
});

// ---------- mobile / responsive view ----------
const DEVICES = [
  ['iphone-se', 'iPhone SE', 375, 667], ['iphone-14', 'iPhone 14', 390, 844], ['iphone-max', 'iPhone Pro Max', 430, 932],
  ['pixel-7', 'Pixel 7', 412, 915], ['galaxy', 'Galaxy S', 360, 780], ['ipad-mini', 'iPad mini', 768, 1024],
  ['ipad-air', 'iPad Air', 820, 1180], ['laptop', 'Laptop', 1366, 768], ['custom', 'Custom', 0, 0],
];
function openMobile() {
  $('home').hidden = true;
  $('mobile').hidden = false;
  const list = $('devList');
  list.textContent = '';
  const cur = settings.mobileDevice || 'iphone-14';
  const pick = (id) => {
    settings.mobileDevice = id;
    list.querySelectorAll('.dev').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    const d = DEVICES.find((x) => x[0] === id);
    if (d && d[2]) { $('devW').value = d[2]; $('devH').value = d[3]; }
    $('customRow').style.opacity = id === 'custom' ? '1' : '.55';
    save();
  };
  for (const [id, name, w, hh] of DEVICES) {
    const b = document.createElement('button');
    b.className = 'dev';
    b.dataset.id = id;
    b.innerHTML = '<b></b><small></small>';
    b.querySelector('b').textContent = name;
    b.querySelector('small').textContent = w ? `${w} × ${hh}` : 'Your own size';
    b.addEventListener('click', () => pick(id));
    list.append(b);
  }
  $('devW').value = settings.mobileW || 390;
  $('devH').value = settings.mobileH || 844;
  pick(cur);
  if (cur === 'custom') { $('devW').value = settings.mobileW || 390; $('devH').value = settings.mobileH || 844; }
  $('mobileFull').checked = !!settings.mobileFull;
}
['devW', 'devH'].forEach((id) => $(id).addEventListener('input', () => {
  settings.mobileDevice = 'custom';
  settings.mobileW = +$('devW').value; settings.mobileH = +$('devH').value;
  document.querySelectorAll('#devList .dev').forEach((b) => b.classList.toggle('on', b.dataset.id === 'custom'));
  $('customRow').style.opacity = '1';
  save();
}));
$('mobileFull').addEventListener('change', () => { settings.mobileFull = $('mobileFull').checked; save(); });
$('mobileBtn').addEventListener('click', openMobile);
$('mobileBack').addEventListener('click', () => { $('mobile').hidden = true; $('home').hidden = false; });
$('mobileGo').addEventListener('click', () => {
  const d = DEVICES.find((x) => x[0] === settings.mobileDevice) || DEVICES[1];
  const w = +$('devW').value || 390, hh = +$('devH').value || 844;
  if (w < 240 || hh < 240) return showErr('Size must be at least 240 × 240.');
  $('mobile').hidden = true; $('home').hidden = false;
  capture('mobile', { w, h: hh, full: $('mobileFull').checked, name: d[0] === 'custom' ? `${w}×${hh}` : d[1] });
});

// ---------- other buttons ----------
$('guide').addEventListener('click', async () => {
  showErr('');
  try {
    if (!guideActive && RESTRICTED.test(await activeUrl())) return showErr('Open a normal website tab to record a guide.');
    await send({ type: guideActive ? 'guideStop' : 'guideStart' });
    window.close();
  } catch (e) { showErr(e.message); }
});
$('rec').addEventListener('click', async () => { await send({ type: 'openRecorder' }); window.close(); });
$('screenShot').addEventListener('click', async () => { await send({ type: 'openRecorder', shot: true }); window.close(); });
$('openImage').addEventListener('click', async () => { await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html?new=1') }); window.close(); });
$('lastShot').addEventListener('click', async () => {
  const r = await chrome.storage.local.get('lastCapture');
  if (!r.lastCapture) return showErr('No screenshot yet — take one first.');
  await chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?id=${r.lastCapture}&action=edit`) });
  window.close();
});
$('manual').addEventListener('click', async () => { await send({ type: 'openManual' }); window.close(); });
$('settings').addEventListener('click', async () => { await send({ type: 'openOptions' }); window.close(); });
$('logReload').addEventListener('click', async () => { await send({ type: 'reloadTab', tabId }); window.close(); });

async function init() {
  const r = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
  document.body.classList.toggle('dark', settings.theme === 'dark');
  bindSettings();
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  tabId = t && t.id;
  refresh();
  setInterval(refresh, 1500);
  renderDocs();
  try {
    const cmds = await chrome.commands.getAll();
    document.querySelectorAll('kbd[data-cmd]').forEach((k) => {
      const c = cmds.find((x) => x.name === k.dataset.cmd);
      k.textContent = (c && c.shortcut) || '';
      if (c && c.shortcut) k.closest('button').title = (k.closest('button').title ? k.closest('button').title + ' — ' : '') + c.shortcut;
    });
  } catch (e) {}
}

init();
