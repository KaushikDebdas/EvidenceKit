import { DEFAULT_SETTINGS, compose, composeOpts, fileName, formatDate } from '../lib/compose.js';
import { dbClear, dbAll } from '../lib/db.js';
import { folderPickerSupported, getSaveDir, setSaveDir, dirPermission } from '../lib/savedir.js';

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };
let savedTimer = null;

const mk = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
};

function fakeScreenshot() {
  const c = mk(1000, 240);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 240);
  g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#e0e7ff');
  x.fillStyle = g; x.fillRect(0, 0, 1000, 240);
  x.fillStyle = '#111827'; x.font = 'bold 26px Arial'; x.fillText('Loan Approval — Admin Panel', 30, 56);
  x.fillStyle = '#c7d2fe'; x.fillRect(30, 84, 420, 14); x.fillRect(30, 112, 340, 14); x.fillRect(30, 140, 380, 14);
  x.fillStyle = '#4f46e5'; x.beginPath(); x.roundRect ? x.roundRect(30, 180, 130, 36, 8) : x.rect(30, 180, 130, 36); x.fill();
  x.fillStyle = '#fff'; x.font = '15px Arial'; x.fillText('Approve', 62, 203);
  return c;
}
const RAW = fakeScreenshot();
const META = {
  url: 'https://admin.example.com/loans/approval?id=1024&status=pending',
  title: 'Loan Approval',
  ts: Date.now(),
  logs: {
    startedAt: Date.now(),
    console: [
      { ts: Date.now(), level: 'info', text: 'Loaded loan #1024' },
      { ts: Date.now(), level: 'error', text: 'Approval failed: code 500' },
    ],
    network: [
      { ts: Date.now(), method: 'GET', url: 'https://admin.example.com/api/loans/1024', status: 200, duration: 84 },
      { ts: Date.now(), method: 'POST', url: 'https://admin.example.com/api/approve', status: 500, duration: 312 },
    ],
  },
};

function preview() {
  META.ts = Date.now();
  const { canvas } = compose(RAW, META, composeOpts(settings), mk);
  const pv = $('pv');
  pv.width = canvas.width; pv.height = canvas.height;
  pv.getContext('2d').drawImage(canvas, 0, 0);
  $('fnEx').textContent = fileName(META, settings.imageFormat === 'jpg' ? 'jpg' : 'png', settings.fileTemplate);
  $('qv').textContent = Math.round(settings.jpgQuality * 100) + '%';
}

async function save() {
  syncDateFmt();
  await chrome.storage.local.set({ settings });
  const s = $('saved');
  s.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => s.classList.remove('show'), 1200);
  preview();
}

function syncDateFmt() {
  $('customRow').style.display = settings.dateFormat === 'custom' ? '' : 'none';
  $('dateEx').textContent = formatDate(new Date(), settings.dateCustom || 'DD/MM/YYYY');
}
function fillDt() {
  syncDateFmt();
  $('dtSel').value = !settings.time ? 'none' : settings.dateMode || 'both';
}
$('dtSel').addEventListener('change', () => {
  const v = $('dtSel').value;
  if (v === 'none') settings.time = false;
  else { settings.time = true; settings.dateMode = v; }
  save();
});

function fill() {
  fillDt();
  document.querySelectorAll('[data-k]').forEach((el) => {
    const v = settings[el.dataset.k];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
}

const NUM_KEYS = ['editWidth', 'captureDelay', 'recFps', 'recCountdownSec'];
function bind() {
  document.querySelectorAll('[data-k]').forEach((el) => {
    const evt = el.type === 'range' || el.type === 'text' || el.type === 'number' || el.type === 'color' ? 'input' : 'change';
    el.addEventListener(evt, () => {
      const k = el.dataset.k;
      if (el.type === 'checkbox') settings[k] = el.checked;
      else if (el.type === 'number' || el.type === 'range') settings[k] = +el.value;
      else if (NUM_KEYS.includes(k)) settings[k] = +el.value;
      else settings[k] = el.value;
      if (k === 'recCountdownSec') settings.recCountdown = +el.value > 0;
      save();
    });
  });
}

$('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
$('clearSteps').addEventListener('click', async () => {
  if (confirm('Delete every step and section of BOTH the User Manual and the Test Evidence?\n\nThis cannot be undone.')) { await dbClear('steps'); await renderStorage(); alert('Done.'); }
});
// ---------- storage: how much is used, and the 24-hour screenshots ----------
async function renderStorage() {
  try {
    const [est, temp, steps] = await Promise.all([
      navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve({}),
      dbAll('captures'), dbAll('steps'),
    ]);
    const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
    const size = (list) => list.reduce((a, r) => a + ['blob', 'raw'].reduce((b, k) => b + (r[k] && r[k].size ? r[k].size : 0), 0) + (r.edit && r.edit.raw ? r.edit.raw.size : 0), 0);
    $('storageInfo').textContent = `Temporary screenshots: ${temp.length} (${mb(size(temp))}) · User Manual + Test Evidence: ${steps.filter((s) => s.type !== 'section').length} steps (${mb(size(steps))})`
      + (est.usage != null ? ` · used by EvidenceKit in total: ${mb(est.usage)}` : '') + '.';
  } catch (e) { $('storageInfo').textContent = ''; }
}
$('clearTemp').addEventListener('click', async () => {
  if (!confirm('Delete all temporary screenshots now?\n\n“Last capture” and editors that are still open will no longer find their picture. The User Manual and Test Evidence are not touched.')) return;
  await dbClear('captures');
  await chrome.storage.local.remove('lastCapture');
  await renderStorage();
  alert('Temporary screenshots deleted. Chrome gives the disk space back over the next minutes.');
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Reset all settings to defaults?')) return;
  settings = { ...DEFAULT_SETTINGS };
  await chrome.storage.local.set({ settings });
  fill(); preview();
});

// ---------- save location ----------
async function renderWhere() {
  const supported = folderPickerSupported();
  const dir = await getSaveDir();
  document.querySelectorAll('input[name=saveTarget]').forEach((r) => { r.checked = r.value === (settings.saveTarget || 'downloads'); });
  $('dlSub').textContent = settings.saveFolder || '(top level)';
  $('folderOpt').classList.toggle('dis', !supported);
  $('folderOpt').querySelector('input').disabled = !supported;
  $('pickDir').disabled = !supported;
  $('dirName').textContent = dir ? dir.name : 'No folder chosen yet';
  const st = $('dirState');
  $('regrant').hidden = true;
  st.className = 'mut';
  if (!supported) { st.textContent = 'This browser does not let extensions pick folders (Brave turns it off), so files go to Downloads.'; return; }
  if (!dir) { st.textContent = settings.saveTarget === 'folder' ? 'Choose a folder — until then files go to Downloads.' : ''; return; }
  const p = await dirPermission(dir, false);
  if (p === 'granted') { st.textContent = '✓ Access allowed'; st.className = 'ok'; }
  else { st.textContent = 'Chrome needs your OK again to write to this folder (until then files go to Downloads).'; st.className = 'warn'; $('regrant').hidden = false; }
}
document.querySelectorAll('input[name=saveTarget]').forEach((r) => r.addEventListener('change', async () => {
  settings.saveTarget = r.value;
  await save();
  if (r.value === 'folder' && !(await getSaveDir())) await pickFolder();
  renderWhere();
}));
async function pickFolder() {
  try {
    const dir = await window.showDirectoryPicker({ id: 'evk-save', mode: 'readwrite', startIn: 'pictures' });
    await setSaveDir(dir);
    await dirPermission(dir, true);
    settings.saveTarget = 'folder';
    await save();
  } catch (e) {
    if (e.name !== 'AbortError') alert('Could not use that folder: ' + e.message);
  }
  renderWhere();
}
$('pickDir').addEventListener('click', pickFolder);
$('regrant').addEventListener('click', async () => { const d = await getSaveDir(); if (d) await dirPermission(d, true); renderWhere(); });

(async function init() {
  const r = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
  fill(); bind(); preview(); renderWhere(); renderStorage();
})();
