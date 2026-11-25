import { dbPut, dbGet, dbAll, dbDel, uid } from './lib/db.js';
import { compose, composeOpts, combine, DEFAULT_SETTINGS, fileName, fmtTime } from './lib/compose.js';
import * as hooklog from './lib/hooklog.js';
import { markOf, bakeMarker } from './lib/stepimg.js';
import { nextSlot, appendTo, setActiveDoc, DOC_NAMES } from './lib/docs.js';

chrome.tabs.onRemoved.addListener((tabId) => {
  hooklog.remove(tabId);
  if (guide.active && guide.tabId === tabId) stopGuide(false);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkOff = (w, h) => new OffscreenCanvas(w, h);
const MAX_IMG_PX = 16000; // longest side of a stitched image (safe canvas size)

// ---------- settings (cached) ----------
let settingsCache = null;
async function getSettings() {
  if (!settingsCache) {
    const r = await chrome.storage.local.get('settings');
    settingsCache = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
  }
  return settingsCache;
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch.settings) return;
  settingsCache = null;
  const was = ch.settings.oldValue || {}, now = ch.settings.newValue || {};
  if ((was.autoLogs !== false) !== (now.autoLogs !== false)) syncHooks();
});

async function dataUrlToBlob(u) { return (await fetch(u)).blob(); }
function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
function flash(text, color = '#16a34a') {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => { if (!guide.active) chrome.action.setBadgeText({ text: '' }); }, 2200);
}

// ---------- housekeeping ----------
async function cleanup() {
  try {
    const all = await dbAll('captures');
    const now = Date.now();
    for (const r of all) {
      const age = now - (r.ts || (r.meta && r.meta.ts) || 0);
      if ((r.tmp && age > 3600e3) || age > 24 * 3600e3) await dbDel('captures', r.id);
    }
  } catch (e) {}
}
chrome.runtime.onInstalled.addListener(async () => {
  const r = await chrome.storage.local.get('settings');
  if (!r.settings) await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, defaultsRev: 3 } });
  else if ((r.settings.defaultsRev || 0) < 3) {
    // new defaults, applied once on update (users can change them back):
    // v1.2.1 12-hour clock with AM/PM + light theme; v1.4.1 no time zone name
    const { editorTheme, ...rest } = r.settings;
    const s = { ...DEFAULT_SETTINGS, ...rest, showTz: false, defaultsRev: 3 };
    if ((r.settings.defaultsRev || 0) < 2) Object.assign(s, { timeFormat: '12', theme: 'light' });
    await chrome.storage.local.set({ settings: s });
  }
  cleanup();
  scheduleCleanup();
  syncHooks();
});
chrome.runtime.onStartup.addListener(() => { cleanup(); scheduleCleanup(); syncHooks(); });

// Captures are kept for 24 h. The browser often stays open for days, so the cleanup also runs every hour
// (not only when the browser starts).
const CLEANUP_ALARM = 'evk-cleanup';
function scheduleCleanup() {
  chrome.alarms.get(CLEANUP_ALARM).then((a) => { if (!a) chrome.alarms.create(CLEANUP_ALARM, { delayInMinutes: 1, periodInMinutes: 60 }); }).catch(() => {});
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === CLEANUP_ALARM) cleanup(); });
scheduleCleanup(); // alarms can be dropped by a browser restart: make sure one exists whenever the worker starts
chrome.alarms.clear('qaep-cleanup').catch(() => {}); // name used before the rename to EvidenceKit

// ---------- tab helpers ----------
async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error('No active tab found.');
  return t;
}
function checkTab(tab) {
  const u = tab.url || '';
  if (/^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(u) || /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(u)) {
    throw new Error('Chrome does not allow capturing this page (browser/internal/Web Store page). Open a normal website tab.');
  }
}
async function exec(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r && r.result;
}
async function pageInfo(tabId) {
  try {
    return await exec(tabId, () => ({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent, title: document.title }));
  } catch (e) { return {}; }
}

// ---------- logs ----------
// console + network come from the page hooks (content/hook-main.js -> lib/hooklog.js)
// The hooks are registered only while "Capture console & network logs" is on in Settings. When it is off,
// no script runs in web pages at all (so DevTools shows every console message at its own line again).
const HOOK_SCRIPTS = [
  { id: 'evk-hook-main', js: ['content/hook-main.js'], world: 'MAIN' },
  { id: 'evk-hook-relay', js: ['content/hook-relay.js'], world: 'ISOLATED' },
].map((s) => ({ ...s, matches: ['http://*/*', 'https://*/*'], runAt: 'document_start', allFrames: true, persistAcrossSessions: true }));
const LEGACY_HOOK_IDS = ['qaep-hook-main', 'qaep-hook-relay']; // ids used before the rename to EvidenceKit
let hooksChain = Promise.resolve();
function syncHooks() {
  hooksChain = hooksChain.then(async () => {
    const old = await chrome.scripting.getRegisteredContentScripts({ ids: LEGACY_HOOK_IDS });
    if (old.length) await chrome.scripting.unregisterContentScripts({ ids: old.map((x) => x.id) }); // else the hooks would run twice
    const s = await getSettings();
    const ids = HOOK_SCRIPTS.map((x) => x.id);
    const have = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (s.autoLogs !== false) {
      if (have.length === ids.length) return;
      if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have.map((x) => x.id) });
      await chrome.scripting.registerContentScripts(HOOK_SCRIPTS);
    } else if (have.length) {
      await chrome.scripting.unregisterContentScripts({ ids: have.map((x) => x.id) });
    }
  }).catch((e) => console.error('log hooks:', e));
  return hooksChain;
}
syncHooks();
async function getLogs(tabId) {
  // the pages send their entries once a second: collect whatever is still waiting before taking the snapshot
  try {
    const s = await getSettings();
    if (s.autoLogs !== false) {
      const res = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => (typeof window.__evkTake === 'function' ? window.__evkTake() : []),
      });
      const batch = res.flatMap((r) => r.result || []);
      if (batch.length) await hooklog.onBatch(tabId, batch);
    }
  } catch (e) {}
  return hooklog.snapshot(tabId);
}
async function logStatus(tabId) {
  const h = await hooklog.status(tabId);
  return { hooked: h.hooked, console: h.console, errors: h.errors, network: h.network, failed: h.failed };
}

// ---------- capture primitives ----------
let lastCaptureAt = 0;
let captureQueue = Promise.resolve();
// One capture at a time (two steps can arrive in the same instant), at most ~2 per second as Chrome requires.
function captureTab(tab) {
  const run = captureQueue.then(async () => {
    const wait = Math.max(0, 600 - (Date.now() - lastCaptureAt));
    if (wait) await sleep(wait);
    try {
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } finally {
      lastCaptureAt = Date.now();
    }
  });
  captureQueue = run.catch(() => {});
  return run;
}
async function capVisible(tab) { return dataUrlToBlob(await captureTab(tab)); }

function hideFixed() {
  const hidden = [];
  document.querySelectorAll('*').forEach((el) => {
    const p = getComputedStyle(el).position;
    if (p === 'fixed' || p === 'sticky') { el.__evkV = el.style.visibility; el.style.visibility = 'hidden'; hidden.push(el); }
  });
  window.__evkHidden = hidden;
}
function restorePage(x, y) {
  (window.__evkHidden || []).forEach((el) => { el.style.visibility = el.__evkV || ''; });
  window.__evkHidden = [];
  document.documentElement.style.scrollBehavior = window.__evkSB || '';
  scrollTo(x, y);
}

// Runs in the page: the biggest visible box that scrolls up/down (kept in window.__evkScrollEl).
function findMainScroller() {
  const vw = innerWidth, vh = innerHeight;
  let best = null, bestArea = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el.scrollHeight <= el.clientHeight + 20 || el.clientHeight < 80) continue;
    const oy = getComputedStyle(el).overflowY;
    if (!/(auto|scroll|overlay)/.test(oy)) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const area = w * h;
    if (area > bestArea) { best = el; bestArea = area; }
  }
  if (!best || bestArea < vw * vh * 0.15) return null; // nothing big enough to count as "the page"
  window.__evkScrollEl = best;
  const r = best.getBoundingClientRect();
  const x = Math.max(0, r.left + best.clientLeft), y = Math.max(0, r.top + best.clientTop);
  return {
    vw, vh, x, y, w: Math.min(best.clientWidth, vw - x), h: Math.min(best.clientHeight, vh - y),
    sh: best.scrollHeight, ch: best.clientHeight, st: best.scrollTop,
  };
}

// The whole window, with the main box stretched to its full content height:
// everything above the box stays on top, the box grows, everything below it moves to the bottom.
async function capFullApp(tab, a) {
  const run = (func, args = []) => exec(tab.id, func, args);
  const setTop = (y) => run((v) => {
    const el = window.__evkScrollEl;
    const sb = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = v;
    el.style.scrollBehavior = sb;
    return new Promise((r) => setTimeout(() => r(el.scrollTop), 300)); // lazy lists need a moment to render
  }, [y]);
  const step = Math.max(40, a.h - 40); // small overlap so nothing is lost at the joins
  const max = Math.max(0, a.sh - a.ch);
  const positions = [];
  for (let p = 0; p < max; p += step) positions.push(p);
  if (!positions.length || positions[positions.length - 1] !== max) positions.push(max);

  let out = null, ctx = null, sc = 1, extra = 0;
  try {
    for (let i = 0; i < positions.length; i++) {
      // past the bottom of the image: stop instead of taking screenshots that would not be used
      if (out && Math.round((a.y + positions[i]) * sc) >= out.height) break;
      const real = await setTop(positions[i]);
      const bmp = await shotBitmap(tab);
      if (i === 0) {
        sc = bmp.width / a.vw;
        extra = max; // how much taller the box gets
        const H = Math.min(MAX_IMG_PX, Math.round((a.vh + extra) * sc));
        out = new OffscreenCanvas(bmp.width, H);
        ctx = out.getContext('2d');
        // background for the stretched area beside the box (sidebars): the colour just under the box's left edge
        const probe = new OffscreenCanvas(1, 1).getContext('2d');
        probe.drawImage(bmp, Math.max(0, Math.round((a.x - 2) * sc)), Math.max(0, Math.round((a.y + a.h - 2) * sc)), 1, 1, 0, 0, 1, 1);
        const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
        ctx.fillStyle = a.x > 4 ? `rgb(${r},${g},${b})` : '#ffffff';
        ctx.fillRect(0, 0, out.width, out.height);
        const boxBottom = Math.round((a.y + a.h) * sc);
        // above + beside the box (first screen) at the top, below the box moved down by "extra"
        ctx.drawImage(bmp, 0, 0, bmp.width, boxBottom, 0, 0, bmp.width, boxBottom);
        if (bmp.height > boxBottom) ctx.drawImage(bmp, 0, boxBottom, bmp.width, bmp.height - boxBottom, 0, boxBottom + Math.round(extra * sc), bmp.width, bmp.height - boxBottom);
        // sticky rows inside the box would repeat in every piece: hide them from now on
        await run(() => {
          const list = [];
          window.__evkScrollEl.querySelectorAll('*').forEach((el) => {
            if (getComputedStyle(el).position === 'sticky') { list.push([el, el.style.visibility]); el.style.visibility = 'hidden'; }
          });
          window.__evkSticky = list;
        }).catch(() => {});
      }
      const piece = cropBmp(bmp, { x: a.x, y: a.y, w: a.w, h: a.h }, a.vw);
      bmp.close();
      const dy = Math.round((a.y + real) * sc);
      if (dy >= out.height) break;
      ctx.drawImage(piece, Math.round(a.x * sc), dy);
    }
  } finally {
    await run(() => { (window.__evkSticky || []).forEach(([el, v]) => { el.style.visibility = v; }); window.__evkSticky = null; }).catch(() => {});
    await setTop(a.st).catch(() => {});
  }
  return out.convertToBlob({ type: 'image/png' });
}

// Runs in the page: open every box that scrolls up/down (tables, side panels, lists, a scrolling <body>)
// to its full height, and un-clip the parents around it, so the whole page becomes one long page.
// Returns how many boxes were opened (0 = nothing changed). restoreScrollers() puts everything back.
function expandScrollers() {
  const de = document.documentElement, body = document.body;
  if (!body) return 0;
  const vh = innerHeight;
  const scrolls = (el, cs) => el.scrollHeight > el.clientHeight + 8 && /(auto|scroll|overlay)/.test(cs.overflowY);
  const found = [];
  for (const el of [body, ...body.querySelectorAll('*')]) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.clientHeight < 30 || el.clientWidth < 50) continue;
    const cs = getComputedStyle(el);
    if (!scrolls(el, cs) || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    found.push(el);
  }
  const pageScrolls = de.scrollHeight > vh + 4 && getComputedStyle(de).overflowY !== 'hidden' && !found.includes(body);
  // just one big inner box and a page that does not scroll: the older "stretch the box" capture handles that
  // best (it scrolls the box itself, so lists that only draw the rows on screen still come out complete)
  if (!found.length || (!pageScrolls && found.length === 1 && found[0] !== body)) return 0;

  const saved = [];
  window.__evkOpened = saved;
  window.__evkWin = [scrollX, scrollY];
  const open = (el, unfix) => {
    if (el.__evkS === undefined) { el.__evkS = { css: el.getAttribute('style'), st: el.scrollTop }; saved.push(el); }
    el.style.setProperty('overflow', 'visible', 'important');
    el.style.setProperty('height', 'auto', 'important');
    el.style.setProperty('max-height', 'none', 'important');
    el.style.setProperty('min-height', 'auto', 'important');
    if (unfix) el.style.setProperty('position', 'absolute', 'important');
  };
  found.forEach((el) => open(el));
  // parents that are now too short for the taller box (cut it off, scroll it, or let it spill out): grow them too
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const el of found) {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        const clips = a.scrollHeight > a.clientHeight + 4; // cut off, scrolled, or a fixed height the content spills out of
        const fixedRoot = cs.position === 'fixed' && a.getBoundingClientRect().height >= vh * 0.5; // a full-screen app shell
        if (clips || fixedRoot || ((a === de || a === body) && cs.overflowY === 'hidden')) {
          if (a.__evkS === undefined || clips) { open(a, fixedRoot); changed = true; }
        }
      }
    }
    if (!changed) break;
  }
  scrollTo(0, 0);
  return saved.length;
}
function restoreScrollers() {
  const list = window.__evkOpened || [];
  for (const el of list) {
    if (el.__evkS.css == null) el.removeAttribute('style'); else el.setAttribute('style', el.__evkS.css);
  }
  for (const el of list) { el.scrollTop = el.__evkS.st; delete el.__evkS; }
  window.__evkOpened = null;
  const [x, y] = window.__evkWin || [scrollX, scrollY];
  scrollTo(x, y);
}

// ---------- full page of a PDF ----------
// Chrome's PDF viewer cannot be scrolled or read by an extension: the PDF is drawn page by page instead
// (offscreen document + pdf.js). If that is not possible, the visible part is taken and the reason is shown.
async function isPdfTab(tab) {
  const u = tab.url || '';
  if (!/^(https?|file|blob):/i.test(u)) return false;
  const type = await exec(tab.id, () => document.contentType).catch(() => null);
  return type ? /pdf/i.test(type) : /\.pdf([?#]|$)/i.test(u);
}
// The PDF's bytes, read inside the tab: there the report's login, a blob: address and the site's own cookies
// all still work. null when the tab cannot give them (then the address is loaded again from the extension).
async function pdfFromTab(tab) {
  const got = await exec(tab.id, async () => {
    try {
      const r = await fetch(location.href, { credentials: 'include' });
      if (!r.ok) return { err: 'HTTP ' + r.status };
      const b = await r.blob();
      if (b.size > 60 * 1048576) return { err: 'too big' };
      const head = await b.slice(0, 1024).text();
      if (!head.includes('%PDF-')) return { err: 'not a PDF' }; // e.g. a POST report: a GET gives a login / error page
      return await new Promise((res) => { const f = new FileReader(); f.onload = () => res({ data: f.result }); f.onerror = () => res({ err: 'read' }); f.readAsDataURL(b); });
    } catch (e) { return { err: String(e && e.message || e) }; }
  }).catch((e) => ({ err: e.message }));
  return got && got.data ? dataUrlToBlob(got.data) : null;
}
async function capPdf(tab) {
  const fromTab = await pdfFromTab(tab);
  if (!fromTab) {
    if (/^blob:/i.test(tab.url)) throw new Error('This PDF is no longer available in the tab. Download it (⬇ in the PDF bar), open the downloaded file in Chrome and press Full page there.');
    if (/^file:/i.test(tab.url) && !(await chrome.extension.isAllowedFileSchemeAccess())) {
      throw new Error('To capture every page of a PDF from your computer, open chrome://extensions → EvidenceKit → Details and turn on “Allow access to file URLs”.');
    }
  }
  const key = 'tmp-' + uid();
  const srcKey = fromTab ? key + '-src' : '';
  if (fromTab) await dbPut('captures', { id: srcKey, blob: fromTab, ts: Date.now(), tmp: true });
  try {
    await ensureOffscreen();
    const r = await Promise.race([ // never wait for ever: a very big PDF gets 90 s
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'renderPdf', url: tab.url, srcKey, maxH: MAX_IMG_PX, key }),
      sleep(90000).then(() => ({ error: 'drawing its pages took too long' })),
    ]);
    if (!r || !r.ok) {
      const why = ((r && r.error) || 'no answer').replace(/^Error:\s*/, '');
      throw new Error(/opened again|downloaded again/.test(why)
        ? 'This PDF was made only for this tab (after a login or a form) and cannot be loaded again. Download it (⬇ in the PDF bar), open the downloaded file in Chrome and press Full page there.'
        : 'This PDF could not be read: ' + why);
    }
    const rec = await dbGet('captures', key);
    if (!rec || !rec.blob) throw new Error('This PDF could not be read.');
    return rec.blob;
  } finally {
    await dbDel('captures', key).catch(() => {});
    if (srcKey) await dbDel('captures', srcKey).catch(() => {});
  }
}
async function capPdfOrVisible(tab) {
  try {
    return await capPdf(tab);
  } catch (e) {
    const blob = await capVisible(tab);
    setTimeout(() => pageToast(tab.id, `Only the visible part was captured. ${e.message}`, 'err', { title: 'PDF: not every page' }), 2500);
    return blob;
  }
}

// expand: open inner scroll boxes first (off for an element capture, which crops by the page's normal layout)
async function capFull(tab, { expand = true } = {}) {
  if (expand && (await isPdfTab(tab))) return capPdfOrVisible(tab);
  const opened = expand && (await getSettings()).fullScrollAreas !== false
    ? await exec(tab.id, expandScrollers).catch(() => 0) : 0;
  if (!opened) return capFullPage(tab);
  try {
    await sleep(400); // let the page lay itself out again
    return await capFullPage(tab);
  } finally {
    await exec(tab.id, restoreScrollers).catch(() => {});
  }
}

async function capFullPage(tab) {
  const info = await exec(tab.id, () => {
    const de = document.documentElement, b = document.body;
    return { vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio || 1, total: Math.max(de.scrollHeight, b ? b.scrollHeight : 0), x: scrollX, y: scrollY };
  });
  if (!info) return capVisible(tab);
  if (info.total <= info.vh + 4) {
    // the page itself does not scroll: app-style layout -> scroll its main inner box instead
    const app = await exec(tab.id, findMainScroller).catch(() => null);
    return app ? capFullApp(tab, app) : capVisible(tab);
  }

  await exec(tab.id, () => {
    window.__evkSB = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    scrollTo(0, 0);
  });
  await sleep(250);

  // The image stops at MAX_IMG_PX, so only scroll as far as that: very long / endless pages would
  // otherwise take dozens of screenshots that never reach the picture (and could run out of memory).
  const maxY = info.total - info.vh;
  const lastY = Math.max(0, Math.min(maxY, Math.floor(MAX_IMG_PX / info.dpr) - info.vh));
  const positions = [];
  for (let y = 0; y < lastY; y += info.vh) positions.push(y);
  if (positions[positions.length - 1] !== lastY) positions.push(lastY);

  // each slice is drawn as soon as it is taken, so only one screenshot is kept in memory at a time
  let oc = null, ctx = null, sc = 1;
  try {
    for (let i = 0; i < positions.length; i++) {
      const real = await exec(tab.id, (y) => new Promise((r) => { scrollTo(0, y); setTimeout(() => r(scrollY), 240); }), [positions[i]]);
      const bmp = await createImageBitmap(await dataUrlToBlob(await captureTab(tab)));
      if (!oc) {
        sc = bmp.width / info.vw;
        oc = new OffscreenCanvas(bmp.width, Math.max(1, Math.min(Math.round(info.total * sc), MAX_IMG_PX)));
        ctx = oc.getContext('2d');
      }
      ctx.drawImage(bmp, 0, Math.round(real * sc));
      bmp.close();
      if (i === 0) await exec(tab.id, hideFixed);
    }
  } finally {
    await exec(tab.id, restorePage, [info.x, info.y]).catch(() => {});
  }
  return oc.convertToBlob({ type: 'image/png' });
}

// ---------- area / dual / element selection ----------
// The page is "frozen" first (screenshot taken before the overlay shows), so menus and tooltips stay open.
const pendingSel = new Map(); // tabId -> { tab, mode, bmp, parts: [canvas] }

async function shotBitmap(tab) { return createImageBitmap(await dataUrlToBlob(await captureTab(tab))); }

function cropBmp(bmp, rect, vw) {
  const sc = bmp.width / (vw || bmp.width);
  const x = Math.max(0, Math.round(rect.x * sc));
  const y = Math.max(0, Math.round(rect.y * sc));
  const w = Math.max(1, Math.min(bmp.width - x, Math.round(rect.w * sc)));
  const h = Math.max(1, Math.min(bmp.height - y, Math.round(rect.h * sc)));
  const oc = new OffscreenCanvas(w, h);
  oc.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
  return oc;
}

async function startSelect(tab, mode) {
  const s = await getSettings();
  const freeze = mode === 'scroll' ? false : mode !== 'area' || s.freezeArea !== false;
  let frozen = null, bmp = null;
  if (freeze) {
    frozen = await captureTab(tab);
    bmp = await createImageBitmap(await dataUrlToBlob(frozen));
  }
  pendingSel.set(tab.id, { tab, mode, bmp, parts: [] });
  await exec(tab.id, (cfg) => { window.__evkSelCfg = cfg; }, [{ mode, frozen }]);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/selector.js'] });
}

// The selection lives in memory. selector.js pings every 20 s so Chrome does not stop this worker while
// the user is still selecting; if it was stopped anyway (or the extension reloaded), the frozen picture is
// gone, so we fall back to a fresh screenshot instead of silently doing nothing.
function selState(tab, mode) {
  let p = pendingSel.get(tab.id);
  if (!p) { p = { tab, mode: mode || 'area', bmp: null, parts: [] }; pendingSel.set(tab.id, p); }
  return p;
}

async function selPart(tab, msg, live) {
  const p = selState(tab, msg.mode);
  let bmp = p.bmp;
  if (!live && !bmp) return; // frozen picture lost and the overlay is still on screen: nothing clean to crop
  if (live) { await sleep(200); bmp = await shotBitmap(p.tab); }
  p.parts.push(cropBmp(bmp, msg.rect, msg.vw));
}

async function selDone(senderTab, msg) {
  const tabId = senderTab.id;
  const p = pendingSel.get(tabId) || { tab: senderTab, mode: msg.mode || 'area', bmp: null, parts: [] };
  pendingSel.delete(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => p.tab);
  const s = await getSettings();
  if (msg.scroll) return capScroll(tab, msg.scroll);
  if (msg.big) {
    // element taller / wider than the screen: full page capture, then crop in page coordinates
    await sleep(150);
    const full = await createImageBitmap(await capFull(tab, { expand: false }));
    const out = cropBmp(full, msg.doc, msg.vw);
    full.close();
    return finalize(tab, await out.convertToBlob({ type: 'image/png' }), 'element');
  }
  let bmp = p.bmp;
  if (msg.live || !bmp) { await sleep(200); bmp = await shotBitmap(tab); }
  const parts = p.parts.concat((msg.parts || []).map((r) => cropBmp(bmp, r, msg.vw)));
  if (!parts.length) return;
  let out = parts[0];
  if (p.mode === 'dual' && parts.length > 1) {
    out = combine(parts, { layout: s.dualLayout, labels: s.dualLabels !== false, gap: 16 }, mkOff).canvas;
  }
  await finalize(tab, await out.convertToBlob({ type: 'image/png' }), p.mode);
}

// ---------- split view: several windows / tabs side by side ----------
const RESTRICTED_URL = /^(chrome|chrome-extension|edge|about|devtools|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

async function splitCapture(opts = {}) {
  const s = await getSettings();
  const full = opts.full != null ? !!opts.full : !!s.splitFull;
  const layout = opts.layout || s.splitLayout || 'auto';
  const startWin = await chrome.windows.getLastFocused().catch(() => null);
  let targets = [];
  if (opts.tabIds && opts.tabIds.length) {
    for (const id of opts.tabIds) { const t = await chrome.tabs.get(id).catch(() => null); if (t) targets.push(t); }
  } else {
    // keyboard shortcut: the current tab of every open window ...
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    wins.filter((w) => w.state !== 'minimized').sort((a, b) => (a.left - b.left) || (a.top - b.top)).forEach((w) => {
      const t = (w.tabs || []).find((x) => x.active);
      if (t && !RESTRICTED_URL.test(t.url || '')) targets.push(t);
    });
    // ... or, with one window, your current tab next to the tab you used just before it
    if (targets.length < 2) {
      const all = (await chrome.tabs.query({ windowType: 'normal' })).filter((t) => !RESTRICTED_URL.test(t.url || ''));
      const active = targets[0] || all.find((t) => t.active);
      const prev = all.filter((t) => !active || t.id !== active.id).sort((x, y) => (y.lastAccessed || 0) - (x.lastAccessed || 0))[0];
      targets = [active, prev].filter(Boolean);
    }
  }
  const skipped = targets.filter((t) => RESTRICTED_URL.test(t.url || '')).length;
  targets = targets.filter((t) => !RESTRICTED_URL.test(t.url || '')).slice(0, 6);
  if (!targets.length) throw new Error('Split view needs at least one normal website tab or window' + (skipped ? ' (browser pages cannot be captured)' : '') + '.');
  if (targets.length < 2) throw new Error('Split view needs at least 2 website tabs. Open another tab, then try again.');

  // remember what was active so we can put it back
  const prevActive = new Map();
  for (const t of targets) {
    if (!prevActive.has(t.windowId)) {
      const [a] = await chrome.tabs.query({ active: true, windowId: t.windowId });
      if (a) prevActive.set(t.windowId, a.id);
    }
  }
  const panes = [];
  const info = [];
  const sOpts = { ...composeOpts(s), console: false, network: false };
  try {
    for (const t of targets) {
      await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      await chrome.tabs.update(t.id, { active: true });
      await sleep(450);
      const tab = await chrome.tabs.get(t.id);
      const blob = full ? await capFull(tab) : await capVisible(tab);
      const bmp = await createImageBitmap(blob);
      const pi = await pageInfo(tab.id);
      const pm = { url: tab.url || '', title: pi.title || tab.title || '', ts: Date.now(), logs: null };
      panes.push(compose(bmp, pm, sOpts, mkOff).canvas);
      info.push({ url: pm.url, title: pm.title });
    }
  } finally {
    for (const tabId of prevActive.values()) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    if (startWin) await chrome.windows.update(startWin.id, { focused: true }).catch(() => {});
  }
  // split view compares pages, so 2-3 panes go side by side, more become a grid
  const lay = layout === 'auto' ? (panes.length <= 3 ? 'side' : 'grid') : layout;
  const out = combine(panes, { layout: lay, labels: false, gap: 20, bg: '#d1d5db' }, mkOff).canvas;
  await finalize(targets[0], await out.convertToBlob({ type: 'image/png' }), 'split', { composite: true, panes: info });
}

// ---------- scroll box: a scrollable <div> or an <iframe>, scrolled and stitched ----------
// The element was picked by content/selector.js and kept in window.__evkScrollEl (top frame, isolated world).
async function capScroll(tab, target) {
  const isFrame = target.kind === 'frame';
  let frameId = 0;
  if (isFrame) {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => ({ top: window === top, href: location.href, w: innerWidth, h: innerHeight }),
    });
    const cands = res.filter((r) => r.result && !r.result.top);
    const pick = cands.find((r) => target.src && r.result.href === target.src)
      || cands.find((r) => Math.abs(r.result.w - target.cw) <= 3 && Math.abs(r.result.h - target.ch) <= 3);
    if (!pick) throw new Error('Could not reach the content of this frame.');
    frameId = pick.frameId;
  }
  const inFrame = (func, args = []) => chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, func, args }).then((r) => r[0] && r[0].result);
  // box position in the top frame (bring it into view first)
  const box = await exec(tab.id, () => {
    const el = window.__evkScrollEl;
    if (!el || !el.isConnected) return null;
    const r0 = el.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > innerHeight || r0.left < 0 || r0.right > innerWidth) {
      el.scrollIntoView({ block: r0.height > innerHeight ? 'start' : 'nearest', inline: r0.width > innerWidth ? 'start' : 'nearest' });
    }
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left + el.clientLeft), y = Math.max(0, r.top + el.clientTop);
    return { x, y, w: Math.min(el.clientWidth, innerWidth - x), h: Math.min(el.clientHeight, innerHeight - y), vw: innerWidth, dpr: devicePixelRatio || 1 };
  });
  if (!box || box.w < 4 || box.h < 4) throw new Error('The scroll box is not visible.');
  const meas = await inFrame((frame) => {
    const el = frame ? document.scrollingElement || document.documentElement : window.__evkScrollEl;
    return { sw: el.scrollWidth, cw: el.clientWidth, sl: el.scrollLeft, sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop };
  }, [isFrame]);
  // scroll positions on one axis (each step = what is visible of the box), stopping at the 16 000 px image limit
  const axis = (total, view, boxSize) => {
    const step = Math.max(20, Math.min(boxSize, view));
    const max = Math.max(0, total - view);
    const p = [];
    for (let v = 0; v < max; v += step) p.push(v);
    if (!p.length || p[p.length - 1] !== max) p.push(max);
    return { p: p.filter((v, i) => i === 0 || v * box.dpr < 16000), max };
  };
  const X = axis(meas.sw, meas.cw, box.w);
  const Y = axis(meas.sh, meas.ch, box.h);
  if (X.p.length * Y.p.length > 150) {
    throw new Error(`This box is very big (${meas.sw} × ${meas.sh} px, ${X.p.length * Y.p.length} pieces). Zoom the page out a little (Ctrl −) and try again.`);
  }
  const setScroll = (x, y) => inFrame((frame, sx, sy) => {
    const el = frame ? document.scrollingElement || document.documentElement : window.__evkScrollEl;
    const sb = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    el.scrollLeft = sx;
    el.scrollTop = sy;
    el.style.scrollBehavior = sb;
    return new Promise((r) => setTimeout(() => r({ x: el.scrollLeft, y: el.scrollTop }), 220));
  }, [isFrame, x, y]);
  // sticky header rows / frozen columns inside the box would repeat in every piece:
  // hide each one only in the pieces where it is "stuck" (scrolled away from its own place)
  const stickyCount = await inFrame((frame) => {
    const root = frame ? document.documentElement : window.__evkScrollEl;
    const list = [];
    root.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.position === 'sticky') {
        list.push({ el, v: cs.top !== 'auto' || cs.bottom !== 'auto', h: cs.left !== 'auto' || cs.right !== 'auto', orig: el.style.visibility });
      } else if (cs.position === 'fixed' && frame) list.push({ el, v: true, h: true, orig: el.style.visibility });
    });
    window.__evkSticky = list;
    return list.length;
  }, [isFrame]).catch(() => 0);
  const applySticky = (movedX, movedY) => (stickyCount
    ? inFrame((mx, my) => { for (const it of window.__evkSticky || []) it.el.style.visibility = (it.v && my) || (it.h && mx) ? 'hidden' : it.orig; }, [movedX, movedY])
    : Promise.resolve());

  let out = null, ctx = null, sc = 1;
  try {
    for (const py of Y.p) {
      for (const px of X.p) {
        await applySticky(px > 0, py > 0);
        const real = await setScroll(px, py);
        const bmp = await shotBitmap(tab);
        if (!out) {
          sc = bmp.width / box.vw;
          const W = Math.min(16000, Math.round(Math.min(meas.sw, X.max + box.w) * sc));
          const H = Math.min(16000, Math.round(Math.min(meas.sh, Y.max + box.h) * sc));
          out = new OffscreenCanvas(W, H);
          ctx = out.getContext('2d');
        }
        ctx.drawImage(cropBmp(bmp, box, box.vw), Math.round(real.x * sc), Math.round(real.y * sc));
      }
    }
  } finally {
    if (stickyCount) await inFrame(() => { for (const it of window.__evkSticky || []) it.el.style.visibility = it.orig; window.__evkSticky = null; }).catch(() => {});
    await setScroll(meas.sl, meas.st).catch(() => {});
  }
  await finalize(tab, await out.convertToBlob({ type: 'image/png' }), 'scroll');
}

// ---------- mobile / responsive view: resize the window, capture, put it back ----------
async function capResponsive(tab, o) {
  const w = Math.max(240, Math.min(3840, Math.round(+o.w || 390)));
  const h = Math.max(240, Math.min(2160, Math.round(+o.h || 844)));
  const win = await chrome.windows.get(tab.windowId);
  const prev = { state: win.state, left: win.left, top: win.top, width: win.width, height: win.height };
  const inner = () => exec(tab.id, () => ({ iw: innerWidth, ih: innerHeight }));
  if (win.state !== 'normal') { await chrome.windows.update(win.id, { state: 'normal' }); await sleep(300); }
  const cur = await chrome.windows.get(win.id);
  const i0 = await inner();
  const dw = cur.width - i0.iw, dh = cur.height - i0.ih; // browser frame + toolbars
  let blob, got;
  try {
    await chrome.windows.update(win.id, { width: w + dw, height: h + dh });
    await sleep(700);
    got = await inner();
    if (Math.abs(got.iw - w) > 2 || Math.abs(got.ih - h) > 2) { // one correction pass
      const c2 = await chrome.windows.get(win.id);
      await chrome.windows.update(win.id, { width: c2.width + (w - got.iw), height: c2.height + (h - got.ih) });
      await sleep(500);
      got = await inner();
    }
    if (Math.abs(got.iw - w) > 8) throw new Error('window-min-size');
    blob = o.full ? await capFull(tab) : await capVisible(tab);
  } catch (e) {
    if (e.message !== 'window-min-size') throw e;
  } finally {
    // put the window back; if Chrome refuses those bounds (e.g. the screen changed), maximize instead of leaving it tiny
    const restored = await chrome.windows.update(win.id, { left: prev.left, top: prev.top, width: prev.width, height: prev.height }).then(() => true, () => false);
    if (prev.state !== 'normal' || !restored) await chrome.windows.update(win.id, { state: prev.state !== 'normal' ? prev.state : 'maximized' }).catch(() => {});
  }
  if (!blob) {
    // the browser window cannot get that narrow: open the page in a small popup window instead
    const pw = await chrome.windows.create({ url: tab.url, type: 'popup', width: w + 16, height: h + 60, focused: true });
    const ptab = pw.tabs[0];
    try {
      for (let i = 0; i < 50; i++) { const t = await chrome.tabs.get(ptab.id); if (t.status === 'complete') break; await sleep(200); }
      await sleep(600);
      const pi = await exec(ptab.id, () => ({ iw: innerWidth, ih: innerHeight }));
      const pwin = await chrome.windows.get(pw.id);
      await chrome.windows.update(pw.id, { width: pwin.width + (w - pi.iw), height: pwin.height + (h - pi.ih) });
      await sleep(600);
      const ptab2 = await chrome.tabs.get(ptab.id);
      blob = o.full ? await capFull(ptab2) : await capVisible(ptab2);
      got = await exec(ptab.id, () => ({ iw: innerWidth, ih: innerHeight }));
    } finally {
      await chrome.windows.remove(pw.id).catch(() => {});
    }
  }
  await finalize(tab, blob, 'mobile', { device: { name: o.name || '', w: got.iw, h: got.ih } });
}

// ---------- small on-page helpers (toast + countdown) ----------
async function pageToast(tabId, text, kind = 'ok', x = {}) {
  try {
    await exec(tabId, (t, k, ex) => {
      const old = document.querySelector('[data-evk=toast]');
      if (old) old.remove();
      const h = document.createElement('div');
      h.setAttribute('data-evk', 'toast');
      h.style.cssText = 'all:initial;position:fixed;top:18px;right:18px;z-index:2147483647;';
      const r = h.attachShadow({ mode: 'closed' });
      const err = k === 'err';
      const col = err ? '#dc2626' : '#16a34a';
      const title = (ex && ex.title) || (err ? 'Something went wrong' : 'Done');
      r.innerHTML = '<div id="c" style="font:14px/1.4 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#111827;background:#fff;border-left:6px solid ' + col +
        ';padding:14px 16px 14px 14px;border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.35);width:min(340px,calc(100vw - 56px));box-sizing:border-box;display:flex;gap:12px;align-items:flex-start;opacity:0;transform:translateY(-8px);transition:all .2s">' +
        '<span style="flex:none;width:30px;height:30px;border-radius:50%;background:' + col + ';color:#fff;display:grid;place-items:center;font:700 18px/1 system-ui">' + (err ? '!' : '\u2713') + '</span>' +
        '<div style="min-width:0;flex:1"><div class="ti" style="font-weight:700;font-size:15px"></div><div class="t" style="color:#4b5563;margin-top:2px;word-break:break-word"></div>' +
        (ex && ex.manual ? '<button id="om" style="all:initial;cursor:pointer;margin-top:9px;display:inline-block;background:#4f46e5;color:#fff;font:600 13px system-ui,Arial;padding:6px 12px;border-radius:8px"></button>' : '') +
        '</div><button id="x" style="all:initial;cursor:pointer;color:#9ca3af;font:16px/1 system-ui;padding:2px 4px">\u2715</button></div>';
      r.querySelector('.ti').textContent = title;
      r.querySelector('.t').textContent = t;
      document.documentElement.append(h);
      const el = r.getElementById('c');
      requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'none'; });
      let timer;
      const close = () => { el.style.opacity = '0'; setTimeout(() => h.remove(), 250); };
      const arm = () => { clearTimeout(timer); timer = setTimeout(close, err ? 5000 : 3000); };
      arm();
      el.addEventListener('mouseenter', () => clearTimeout(timer));
      el.addEventListener('mouseleave', arm);
      r.getElementById('x').addEventListener('click', close);
      const om = r.getElementById('om');
      if (om) om.textContent = 'Open ' + (typeof ex.manual === 'string' ? ex.manual : 'User Manual');
      if (om) om.addEventListener('click', () => { try { chrome.runtime.sendMessage({ type: 'openManual' }); } catch (e) {} close(); });
    }, [text, kind, x]);
  } catch (e) {}
}

async function countdown(tabId, secs) {
  try {
    await exec(tabId, (n) => {
      const h = document.createElement('div');
      h.setAttribute('data-evk', 'countdown');
      h.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:none;';
      const r = h.attachShadow({ mode: 'closed' });
      r.innerHTML = '<div style="width:64px;height:64px;border-radius:50%;background:rgba(17,24,39,.88);color:#fff;font:700 28px/64px system-ui,Arial;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.3)"></div>';
      const el = r.firstElementChild;
      document.documentElement.append(h);
      window.__evkCountdown = h;
      let left = n;
      const step = () => { el.textContent = left; left--; if (left > 0) setTimeout(step, 1000); };
      step();
    }, [secs]);
  } catch (e) {}
  await sleep(secs * 1000);
  try { await exec(tabId, () => { if (window.__evkCountdown) window.__evkCountdown.remove(); window.__evkCountdown = null; }); } catch (e) {}
  await sleep(150);
}

// ---------- deliver ----------
function metaOpts(meta, settings) {
  const o = composeOpts(settings);
  // split view panes already carry their own URL bars
  return meta.composite ? { ...o, url: false, time: false, console: false, network: false } : o;
}
async function composeBlob(rawBlob, meta, settings, forceType) {
  const bmp = await createImageBitmap(rawBlob);
  const { canvas } = compose(bmp, meta, metaOpts(meta, settings), mkOff);
  const jpg = (forceType || settings.imageFormat) === 'jpg';
  return canvas.convertToBlob(jpg ? { type: 'image/jpeg', quality: +settings.jpgQuality || 0.92 } : { type: 'image/png' });
}

async function ensureOffscreen() {
  try {
    if (chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctxs.length) return;
    }
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS', 'WORKERS'], justification: 'Create blob URLs to download large screenshots, and draw the pages of a PDF for a full-page capture.' });
  } catch (e) {
    if (!/single offscreen|already exists/i.test(String(e.message))) throw e;
  }
}

// Saves to the folder chosen in Settings, or to Downloads/<folder>. Returns where it went.
async function saveBlob(blob, name, settings) {
  const key = 'tmp-' + uid();
  await dbPut('captures', { id: key, blob, ts: Date.now(), tmp: true });
  await ensureOffscreen();
  let problem = '';
  if (settings.saveTarget === 'folder') {
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'saveToDir', key, name }).catch((e) => ({ ok: false, reason: e.message }));
    if (r && r.ok) {
      await dbDel('captures', key).catch(() => {});
      return { where: 'folder', name: r.name, folder: r.folder };
    }
    problem = (r && r.reason) || 'unknown';
  }
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'blobUrl', key });
  if (!res || !res.url) { releaseTmp(key); throw new Error('Could not prepare the file for download.'); }
  const folder = String(settings.saveFolder || '').replace(/[\\:*?"<>|]/g, '').replace(/^\/+|\/+$/g, '');
  let dlId;
  try {
    dlId = await chrome.downloads.download({
      url: res.url,
      filename: folder ? `${folder}/${name}` : name,
      conflictAction: 'uniquify',
      saveAs: !!settings.saveAs,
    });
  } catch (e) {
    releaseTmp(key);
    throw e;
  }
  // free the blob URL + temporary copy once Chrome has finished writing the file (see downloads.onChanged).
  // Kept in session storage because this worker may be stopped before the download ends.
  if (dlId != null) await chrome.storage.session.set({ ['evkDl' + dlId]: key }).catch(() => {});
  return { where: 'downloads', name, problem };
}
function releaseTmp(key) {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'release', key }).catch(() => {});
  dbDel('captures', key).catch(() => {}); // also when the offscreen page is gone
}
chrome.downloads.onChanged.addListener(async (d) => {
  if (!d.state || d.state.current === 'in_progress') return; // complete or interrupted (incl. "Save as" cancelled)
  const k = 'evkDl' + d.id;
  const r = await chrome.storage.session.get(k).catch(() => ({}));
  if (!r[k]) return;
  await chrome.storage.session.remove(k).catch(() => {});
  releaseTmp(r[k]);
});
function savedText(r) {
  if (r.where === 'folder') return `Saved to ${r.folder}/${r.name}`;
  if (r.problem) return `Saved to Downloads — allow the save folder again in Settings (${r.name})`;
  return 'Saved ' + r.name;
}

async function copyViaTab(tabId, blob) {
  const dataUrl = await blobToDataUrl(blob);
  const res = await exec(
    tabId,
    async (u) => {
      try {
        const bin = atob(u.split(',')[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([arr], { type: 'image/png' }) })]);
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    [dataUrl]
  );
  return res && res.ok;
}

async function openEditor(id, action) {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?id=${id}&action=${action}`) });
}

async function finalize(tab, rawBlob, mode, extra = {}) {
  const settings = await getSettings();
  const fresh = await chrome.tabs.get(tab.id).catch(() => tab);
  const info = await pageInfo(tab.id);
  const meta = {
    id: uid(),
    ts: Date.now(),
    url: fresh.url || '',
    title: info.title || fresh.title || '',
    viewport: extra.device ? { w: extra.device.w, h: extra.device.h, dpr: info.dpr } : { w: info.vw, h: info.vh, dpr: info.dpr },
    ua: info.ua || '',
    mode,
    logs: extra.composite ? null : await getLogs(tab.id),
    ...extra,
  };
  const note = (t, k, x) => (settings.notify !== false ? pageToast(tab.id, t, k, x) : null);
  // every capture is kept (24 h) so the popup's "Last capture" can reopen it in the editor
  await dbPut('captures', { id: meta.id, blob: rawBlob, meta, ts: meta.ts });
  chrome.storage.local.set({ lastCapture: meta.id }).catch(() => {});
  const action = settings.afterAction;
  const ext = settings.imageFormat === 'jpg' ? 'jpg' : 'png';

  if (action === 'edit') {
    return openEditor(meta.id, 'edit');
  }

  if (action === 'save' || action === 'saveedit') {
    const composed = await composeBlob(rawBlob, meta, settings);
    const name = fileName(meta, ext, settings.fileTemplate);
    const sr = await saveBlob(composed, name, settings);
    if (action === 'save') { note(savedText(sr), sr.problem ? 'err' : 'ok', { title: sr.problem ? 'Could not save' : 'Screenshot saved' }); return flash('✓'); }
    return openEditor(meta.id, 'edit');
  }
  if (action === 'copy' || action === 'copysave') {
    const composed = await composeBlob(rawBlob, meta, settings, 'png');
    let saved = '';
    if (action === 'copysave') {
      const out = ext === 'png' ? composed : await composeBlob(rawBlob, meta, settings);
      saved = fileName(meta, ext, settings.fileTemplate);
      saved = savedText(await saveBlob(out, saved, settings));
    }
    const ok = await copyViaTab(tab.id, composed).catch(() => false);
    if (ok) { note(saved ? 'Copied to clipboard. ' + saved : 'Copied to clipboard', 'ok', { title: saved ? 'Copied and saved' : 'Copied to clipboard' }); return flash('COPY'); }
    return openEditor(meta.id, 'copy');
  }
  if (action === 'manual') {
    // you choose where it goes: "Add to Manual" / "Add to Test Evidence" (press both = added to both)
    await choiceToast(tab.id, meta.id);
  }
}

// After capture → "Add to …": the screenshot (kept in captures) is added when a button on the page is pressed
async function addCaptureTo(id, doc) {
  if (!DOC_NAMES[doc]) return { ok: false, error: 'unknown document' };
  const rec = await dbGet('captures', id);
  if (!rec) return { ok: false, error: 'This screenshot is no longer available.' };
  const settings = await getSettings();
  const blob = await composeBlob(rec.blob, rec.meta, settings, 'png');
  const m = rec.meta;
  const r = await appendTo(doc, [{ blob, title: '', desc: '', url: m.url || '', ts: m.ts, pageTitle: m.title || '', mode: m.mode }]);
  flash('+' + (r.before + 1));
  return { ok: true, n: r.before + 1, name: DOC_NAMES[doc] };
}

async function choiceToast(tabId, captureId) {
  try {
    await exec(tabId, (id, names) => {
      const old = document.querySelector('[data-evk=toast]');
      if (old) old.remove();
      const h = document.createElement('div');
      h.setAttribute('data-evk', 'toast');
      h.style.cssText = 'all:initial;position:fixed;top:18px;right:18px;z-index:2147483647;';
      const r = h.attachShadow({ mode: 'closed' });
      r.innerHTML = `<style>
        .c{font:14px/1.4 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#111827;background:#fff;border-left:6px solid #4f46e5;padding:14px 16px 14px 14px;border-radius:12px;
           box-shadow:0 14px 40px rgba(0,0,0,.35);width:min(360px,calc(100vw - 56px));box-sizing:border-box;opacity:0;transform:translateY(-8px);transition:all .2s}
        .top{display:flex;gap:10px;align-items:flex-start}.ti{font-weight:700;font-size:15px;flex:1}.t{color:#4b5563;margin:2px 0 10px}
        .x{all:initial;cursor:pointer;color:#9ca3af;font:16px/1 system-ui;padding:2px 4px}
        .row{display:flex;gap:8px;flex-wrap:wrap}
        .b{all:initial;cursor:pointer;flex:1 1 140px;text-align:center;box-sizing:border-box;background:#4f46e5;color:#fff;font:600 13px system-ui,Arial;padding:8px 10px;border-radius:8px}
        .b.ev{background:#0f766e}.b:hover{filter:brightness(1.1)}.b[disabled]{cursor:default;background:#dcfce7;color:#166534}
        .o{all:initial;cursor:pointer;margin-top:9px;display:none;color:#4f46e5;font:600 12.5px system-ui,Arial;text-decoration:underline}
        .err{color:#b91c1c;font-size:12.5px;margin-top:6px}</style>
        <div class="c"><div class="top"><div class="ti">Screenshot taken</div><button class="x" title="Close">✕</button></div>
        <div class="t">Add it to — press both to add it to both:</div>
        <div class="row"><button class="b" data-doc="manual">＋ ${names.manual}</button><button class="b ev" data-doc="evidence">＋ ${names.evidence}</button></div>
        <button class="o">Open</button><div class="err"></div></div>`;
      document.documentElement.append(h);
      const c = r.querySelector('.c');
      requestAnimationFrame(() => { c.style.opacity = '1'; c.style.transform = 'none'; });
      let timer;
      const close = () => { c.style.opacity = '0'; setTimeout(() => h.remove(), 250); };
      const arm = (ms) => { clearTimeout(timer); timer = setTimeout(close, ms); };
      arm(20000); // time to decide; stays while the mouse is on it
      c.addEventListener('mouseenter', () => clearTimeout(timer));
      c.addEventListener('mouseleave', () => arm(8000));
      r.querySelector('.x').addEventListener('click', close);
      let last = 'manual';
      const open = r.querySelector('.o');
      open.addEventListener('click', () => { try { chrome.runtime.sendMessage({ type: 'openManual', doc: last }); } catch (e) {} close(); });
      r.querySelectorAll('.b').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = 'Adding…';
        let res;
        try { res = await chrome.runtime.sendMessage({ type: 'addCaptureTo', id, doc: b.dataset.doc }); } catch (e) { res = { ok: false, error: String(e) }; }
        if (res && res.ok) {
          last = b.dataset.doc;
          b.textContent = `✓ ${res.name} · step ${res.n}`;
          open.textContent = 'Open ' + res.name;
          open.style.display = 'inline-block';
          arm(8000);
        } else {
          b.disabled = false;
          b.textContent = '＋ ' + names[b.dataset.doc];
          r.querySelector('.err').textContent = 'Could not add: ' + ((res && res.error) || 'unknown error');
        }
      }));
    }, [captureId, DOC_NAMES]);
  } catch (e) {}
}

const SELECT_MODES = ['area', 'dual', 'element', 'scroll'];
async function doCapture(mode, tab, opts = {}) {
  if (mode === 'split') return splitCapture(opts);
  tab = tab || (await activeTab());
  checkTab(tab);
  try {
    const delay = Math.max(0, Math.min(30, +opts.delay || 0));
    if (delay) await countdown(tab.id, delay);
    // a PDF: "Scroll box" means all its pages, the same as Full page (the viewer cannot be selected in)
    if (mode === 'scroll' && (await isPdfTab(tab))) return await finalize(tab, await capPdfOrVisible(tab), 'full');
    if (SELECT_MODES.includes(mode)) return await startSelect(tab, mode);
    if (mode === 'mobile') return await capResponsive(tab, opts);
    const blob = mode === 'full' ? await capFull(tab) : await capVisible(tab);
    await finalize(tab, blob, mode);
  } catch (e) {
    pageToast(tab.id, 'Capture failed: ' + ((e && e.message) || e), 'err');
    throw e;
  }
}

// ---------- step guide (Scribe-style) ----------
let guide = { active: false, tabId: null, paused: false, count: 0 };
const guideReady = (async () => {
  try {
    const r = await chrome.storage.session.get('evkGuide');
    if (r.evkGuide) guide = { ...guide, ...r.evkGuide };
  } catch (e) {}
})();
const saveGuide = () => chrome.storage.session.set({ evkGuide: guide }).catch(() => {});
let guideChain = Promise.resolve();

async function injectGuide(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/guide.js'] }); } catch (e) {}
}

function setGuideBadge(on) {
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  chrome.action.setBadgeText({ text: on ? 'REC' : '' });
}

// URL / date / time bar on step pictures: the same choice as for screenshots (popup "Add to image").
// Returns the picture with the bar and the bar's height (the click marker goes that much lower).
async function stampStep(shot, page, settings) {
  const o = { ...composeOpts(settings), console: false, network: false };
  if (!page.url) o.url = false; // e.g. a step from another program: no address to show
  if (!o.url && !o.time) return { blob: shot, headerH: 0 };
  const bmp = await createImageBitmap(shot);
  const { canvas, headerH } = compose(bmp, { url: page.url || '', ts: page.ts || Date.now(), title: page.title || '' }, o, mkOff);
  bmp.close();
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), headerH };
}
// screenshot -> { blob (bar + click marker), raw (bar, no marker), mark }
async function stepPicture(dataUrl, msg, page, settings, n) {
  const { blob: base, headerH } = await stampStep(await dataUrlToBlob(dataUrl), page, settings);
  const mark = markOf(msg, settings.guideColor || '#ef4444', headerH);
  return { blob: mark ? await bakeMarker(base, mark, n) : base, raw: mark ? base : null, mark };
}

// A recording waits (doc 'pending', one batch id per recording) until you choose on the manual page:
// Add to Manual / Add to Test Evidence / Both / Discard.
async function guideStep(tab, dataUrl, msg, settings, batch) {
  const n = msg.n || guide.count;
  const url = msg.url || tab.url || '';
  const pic = await stepPicture(dataUrl, msg, { url, ts: msg.ts || Date.now(), title: msg.pageTitle || tab.title || '' }, settings, n);
  const { order } = await nextSlot('pending');
  await dbPut('steps', {
    id: uid(), order, doc: 'pending', batch, blob: pic.blob, title: msg.title || '', desc: msg.desc || '', url,
    ts: Date.now(), auto: true, kind: msg.kind || 'click', pageTitle: msg.pageTitle || '',
    // clean copy + where the click was: the manual redraws the number whenever steps move or are deleted
    raw: pic.raw, mark: pic.mark, num: n,
  });
}

async function startGuide(tab) {
  checkTab(tab);
  await guideReady;
  const settings = await getSettings();
  const batch = uid();
  guide = { active: true, tabId: tab.id, paused: false, count: 0, batch };
  saveGuide();
  setGuideBadge(true);
  // every recording gets its own section (rename it later, e.g. "Registration"; in the Test Evidence it is a test case)
  try {
    const { order } = await nextSlot('pending');
    const when = fmtTime(Date.now(), { timeFormat: '12', dateFormat: 'DD MMM YYYY', showTz: false });
    await dbPut('steps', { id: uid(), type: 'section', doc: 'pending', batch, order, title: `Step guide — ${when}`, ts: Date.now() });
  } catch (e) {}
  if (settings.guideFirst) {
    try {
      const u = await captureTab(tab);
      guide.count++;
      saveGuide();
      let host = tab.url;
      try { const x = new URL(tab.url); host = x.hostname + (x.pathname !== '/' ? x.pathname : ''); } catch (e) {}
      await guideStep(tab, u, { title: `Open ${host.slice(0, 80)}`, desc: tab.url, url: tab.url, vw: null }, settings, batch);
    } catch (e) {}
  }
  await injectGuide(tab.id);
}

async function stopGuide(openManual = true) {
  await guideReady;
  const tabId = guide.tabId;
  guide = { active: false, tabId: null, paused: false, count: 0 };
  saveGuide();
  setGuideBadge(false);
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'guideOff' }).catch(() => {});
  await guideChain.catch(() => {});
  // the manual page asks where the recording goes (it also asks later if this tab was closed)
  if (openManual) await chrome.tabs.create({ url: chrome.runtime.getURL('manual/manual.html?waiting=1') });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && guide.active && guide.tabId === tabId && !/^(chrome|edge|about):/.test(tab.url || '')) injectGuide(tabId);
});

// ---------- screen recorder: repro steps (clicks / typing in the recorded tab) ----------
let rec = { active: false, tabId: null, shots: true, values: false, paused: false, n: 0 };
const recReady = (async () => {
  try { const r = await chrome.storage.session.get('evkRec'); if (r.evkRec) rec = { ...rec, ...r.evkRec }; } catch (e) {}
})();
const saveRec = () => chrome.storage.session.set({ evkRec: rec }).catch(() => {});
let recChain = Promise.resolve();
async function injectRecSteps(tabId) {
  try {
    await exec(tabId, () => { window.__evkStepMode = 'rec'; });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/guide.js'] });
  } catch (e) {}
}
async function onRecStep(tab, msg) {
  await recReady;
  // tab recording: only the recorded tab; screen / window recording: every Chrome tab
  if (!rec.active || rec.paused || (!rec.screen && tab.id !== rec.tabId)) return { ok: false };
  rec.n++;
  saveRec();
  const n = rec.n;
  const step = { n, ts: msg.ts || Date.now(), kind: msg.kind || 'click', title: msg.title || '', url: msg.url || tab.url || '', pageTitle: msg.pageTitle || '', img: null };
  if (rec.screen) {
    learnGeo(tab.windowId, msg.geo);
    // the recorder takes this step's picture from the screen video itself (what you really see, any program)
    Object.assign(step, { frame: true, rect: msg.rect || null, pt: msg.pt || null, vw: msg.vw || null, geo: msg.geo || null });
    chrome.runtime.sendMessage({ target: 'recorder', type: 'recStepAdded', step }).catch(() => {});
    return { ok: true, n };
  }
  // capture starts now (the capture queue keeps order); the chain makes "stop" wait for every step received so far
  const shot = rec.shots ? captureTab(tab).catch(() => null) : Promise.resolve(null);
  recChain = recChain.then(async () => {
    const dataUrl = await shot;
    if (dataUrl) {
      const s = await getSettings();
      step.img = 'rs-' + uid();
      const pic = await stepPicture(dataUrl, msg, { url: step.url, ts: step.ts, title: step.pageTitle || tab.title || '' }, s, n);
      await dbPut('captures', { id: step.img, blob: pic.blob, ts: Date.now(), raw: pic.raw, mark: pic.mark, num: n });
    }
    await chrome.runtime.sendMessage({ target: 'recorder', type: 'recStepAdded', step }).catch(() => {});
  }).catch((e) => console.error(e));
  return { ok: true, n };
}

// Screen / window recording: things that happen outside one tab become steps too (the recorder takes the
// picture from the screen video). An extension cannot see clicks inside other programs (Excel, Edge …);
// those show up as "Left Chrome" / "Screen changed" steps, or press "Add step" in the floating controls.
async function recEvent(kind, title, extra = {}, delay = 700) {
  await recReady;
  if (!rec.active || rec.paused || !rec.screen) return;
  rec.n++;
  saveRec();
  const step = { n: rec.n, ts: extra.ts || Date.now(), kind, title, url: extra.url || '', pageTitle: extra.pageTitle || '', img: null, frame: true, geo: extra.geo || null };
  setTimeout(() => chrome.runtime.sendMessage({ target: 'recorder', type: 'recStepAdded', step }).catch(() => {}), delay); // let the screen show it first
}
const tabTitle = (t) => clip(t.title || t.url || 'a tab', 80);
// Where a tab's web page is on the screen, so the recorder can cut the step picture to just that page.
// Read inside the page when possible. Pages no extension may enter (Chrome's PDF viewer, the New Tab page,
// a tab still loading …) use the browser window's place on the screen instead, plus what was learnt from
// another tab of the same window: where the page starts inside the window (below the tab strip and toolbar).
// Without that, the recorder cuts the picture to the whole browser window (still no taskbar or other programs).
function learnGeo(windowId, g) {
  if (!g || !g.iw || !g.sw) return;
  rec.geoScreen = { sl: g.sl, st: g.st, sw: g.sw, sh: g.sh };
  if (windowId != null) rec.insets = { ...(rec.insets || {}), [windowId]: { l: g.ox - g.wx, t: g.oy - g.wy, dw: g.ow - g.iw, dh: g.oh - g.ih } };
  saveRec();
}
async function pageGeo(tab) {
  if (!tab) return null;
  try {
    const g = await exec(tab.id, () => {
      const bw = Math.max(0, (outerWidth - innerWidth) / 2);
      return {
        ox: screenX + bw, oy: screenY + Math.max(0, outerHeight - innerHeight - bw), iw: innerWidth, ih: innerHeight,
        wx: screenX, wy: screenY, ow: outerWidth, oh: outerHeight,
        sl: screen.availLeft || 0, st: screen.availTop || 0, sw: screen.width, sh: screen.height,
      };
    });
    if (g && g.iw) { learnGeo(tab.windowId, g); return g; }
  } catch (e) {}
  await recReady;
  const w = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!w || !rec.geoScreen) return null;
  const g = { wx: w.left, wy: w.top, ow: w.width, oh: w.height, ...rec.geoScreen };
  const ins = (rec.insets || {})[tab.windowId];
  if (ins && w.width - ins.dw > 100 && w.height - ins.dh > 100) {
    Object.assign(g, { ox: w.left + ins.l, oy: w.top + ins.t, iw: w.width - ins.dw, ih: w.height - ins.dh });
  } else g.winOnly = true; // only the browser window is known
  return g;
}
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const newTabs = new Set(); // tabs opened during a screen recording ("Open a new tab …")
chrome.tabs.onCreated.addListener((t) => { if (rec.active && rec.screen) newTabs.add(t.id); });
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await recReady;
  if (!rec.active || !rec.screen) return;
  // a new tab is still "about:blank" at this moment: name it once its page has had time to load
  const at = Date.now(); // the moment of the switch (its place in the step list)
  const opened = newTabs.delete(tabId);
  await sleep(opened ? 1500 : 300);
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (!t) return;
  recEvent('tab', `${opened ? 'Open a new tab' : 'Switch to the tab'} “${tabTitle(t)}”`, { url: t.pendingUrl || t.url, pageTitle: t.title, ts: at, geo: await pageGeo(t) }, opened ? 200 : 400);
  followRecTab(t);
});
chrome.windows.onFocusChanged.addListener(async (winId) => {
  await recReady;
  if (!rec.active || !rec.screen) return;
  if (winId === chrome.windows.WINDOW_ID_NONE) {
    if (rec.outside) return;
    rec.outside = true;
    saveRec();
    chrome.runtime.sendMessage({ target: 'recorder', type: 'recOutside', outside: true }).catch(() => {});
    return recEvent('app', 'Switch to another program', {}, 900);
  }
  const w = await chrome.windows.get(winId, { populate: true }).catch(() => null);
  if (!w || w.type !== 'normal') return; // the recorder window or the floating controls: not a change of program
  if (!rec.outside) return;
  rec.outside = false;
  saveRec();
  chrome.runtime.sendMessage({ target: 'recorder', type: 'recOutside', outside: false }).catch(() => {});
  const t = (w.tabs || []).find((x) => x.active);
  recEvent('app', `Back to Chrome — “${t ? tabTitle(t) : 'Chrome'}”`, { url: t ? t.url : '', pageTitle: t ? t.title : '', geo: t ? await pageGeo(t) : null });
});
// clicks / typing / ripples in whichever tab is in front
async function followRecTab(t) {
  if (!t || RESTRICTED_URL.test(t.url || '')) return;
  injectRecSteps(t.id);
  const r = await chrome.storage.session.get('evkClicks').catch(() => ({}));
  if (r.evkClicks != null) injectClicks(t.id, true);
}

async function stopRecSteps() {
  await recReady;
  const t = rec.tabId;
  const wasScreen = rec.screen;
  rec = { ...rec, active: false, paused: false, screen: false, outside: false };
  saveRec();
  if (t != null) chrome.tabs.sendMessage(t, { type: 'recStepsOff' }).catch(() => {});
  if (wasScreen) { // steps (and click ripples) were followed in every tab
    for (const x of await chrome.tabs.query({})) {
      if (x.id !== t) chrome.tabs.sendMessage(x.id, { type: 'recStepsOff' }).catch(() => {});
      if (!RESTRICTED_URL.test(x.url || '')) injectClicks(x.id, false);
    }
  }
  await recChain.catch(() => {});
}

// The recorder window that started repro steps / click ripples. If it closes without stopping
// (closed mid-recording, crashed), everything it switched on in the recorded tab is switched off here,
// so screenshots are not taken on every click for the rest of the session.
async function setRecOwner(sender) {
  if (sender && sender.tab) await chrome.storage.session.set({ evkRecOwner: sender.tab.id }).catch(() => {});
}
async function recorderGone() {
  await chrome.storage.session.remove('evkRecOwner').catch(() => {});
  await recReady;
  if (rec.active) await stopRecSteps();
  const r = await chrome.storage.session.get('evkClicks').catch(() => ({}));
  if (r.evkClicks != null) {
    await chrome.storage.session.set({ evkClicks: null }).catch(() => {});
    await injectClicks(r.evkClicks, false);
  }
  await guideReady;
  if (!guide.active) chrome.action.setBadgeText({ text: '' }); // the recorder's REC / pause badge
}
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const r = await chrome.storage.session.get('evkRecOwner').catch(() => ({}));
  if (r.evkRecOwner === tabId) await recorderGone();
});

// ---------- screen recorder helpers ----------
async function openRecorder(tab, shot) {
  let src = tab;
  if (!src) src = await activeTab().catch(() => null);
  const q = new URLSearchParams();
  if (src && !RESTRICTED_URL.test(src.url || '')) q.set('tab', src.id);
  if (shot) q.set('mode', 'shot');
  const qs = q.toString();
  await chrome.windows.create({
    url: chrome.runtime.getURL('recorder/recorder.html') + (qs ? '?' + qs : ''),
    type: 'popup', width: shot ? 460 : 480, height: shot ? 540 : 780,
  });
}
async function injectClicks(tabId, on) {
  try {
    if (on) await chrome.scripting.executeScript({ target: { tabId }, files: ['content/clicks.js'] });
    else await exec(tabId, () => { if (window.__evkClicksOff) window.__evkClicksOff(); });
  } catch (e) {}
}
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  try {
    const r = await chrome.storage.session.get('evkClicks');
    if (r.evkClicks === tabId) injectClicks(tabId, true);
  } catch (e) {}
  await recReady;
  if (!rec.active) return;
  if (rec.tabId === tabId) return injectRecSteps(tabId);
  // screen / window recording: follow the tab that is in front after it loads a page
  if (rec.screen) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.active) followRecTab(tab);
  }
});

// ---------- commands (keyboard) ----------
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  try {
    if (cmd === 'record-guide') {
      await guideReady;
      if (guide.active) await stopGuide(true);
      else await startGuide(tab || (await activeTab()));
      return;
    }
    if (cmd === 'record-screen') return await openRecorder(tab);
    if (cmd === 'rec-add-step') return chrome.runtime.sendMessage({ target: 'recorder', type: 'addStepNow' }).catch(() => {});
    if (cmd === 'capture-delayed') {
      const st = await getSettings();
      return await doCapture('visible', tab, { delay: +st.captureDelay || 3 });
    }
    const mode = { 'capture-visible': 'visible', 'capture-area': 'area', 'capture-full': 'full', 'capture-element': 'element', 'capture-dual': 'dual', 'capture-split': 'split', 'capture-scroll': 'scroll' }[cmd];
    if (mode) await doCapture(mode, mode === 'split' ? null : tab);
  } catch (e) {
    flash('!', '#dc2626');
  }
});

// ---------- messages ----------
// work started from the popup runs after the reply; failures show as a red badge + a message on the page
function runLater(fn, label) {
  Promise.resolve().then(fn).catch(async (e) => {
    flash('!', '#dc2626');
    if (label) {
      const t = await activeTab().catch(() => null);
      if (t && !RESTRICTED_URL.test(t.url || '')) pageToast(t.id, `${label}: ${(e && e.message) || e}`, 'err');
    }
  });
}
async function handle(msg, sender) {
  switch (msg.type) {
    case 'capture':
      // answer at once (the popup closes on this answer), then capture
      runLater(() => doCapture(msg.mode, null, { delay: msg.delay, tabIds: msg.tabIds, layout: msg.layout, full: msg.full, w: msg.w, h: msg.h, name: msg.name }), msg.mode === 'split' ? 'Split view' : '');
      return { ok: true };
    case 'selPing':
      return { ok: true }; // keeps the worker awake while the user is selecting
    case 'selPart':
      if (sender.tab) await selPart(sender.tab, msg, false);
      return { ok: true };
    case 'selPartLive':
      if (sender.tab) await selPart(sender.tab, msg, true);
      return { ok: true };
    case 'selDone':
      if (sender.tab) {
        try { await selDone(sender.tab, msg); }
        catch (e) { pageToast(sender.tab.id, 'Capture failed: ' + e.message, 'err'); throw e; }
      }
      return { ok: true };
    case 'selCancel':
      if (sender.tab) pendingSel.delete(sender.tab.id);
      return { ok: true };

    // page hooks
    case 'hookPage': {
      if (!sender.tab) return { ok: true };
      const s = await getSettings();
      if (s.autoLogs) await hooklog.onPage(sender.tab.id, msg.url, s.keepLogs);
      return { ok: true };
    }
    case 'hookLog': {
      if (!sender.tab) return { ok: true };
      const s = await getSettings();
      if (s.autoLogs) await hooklog.onBatch(sender.tab.id, msg.batch);
      return { ok: true };
    }
    case 'logStatus':
      return { ok: true, status: await logStatus(msg.tabId) };
    case 'clearLogs':
      await hooklog.clear(msg.tabId);
      return { ok: true, status: await logStatus(msg.tabId) };
    case 'reloadTab':
      await chrome.tabs.reload(msg.tabId);
      return { ok: true };

    // guide
    case 'guideStart': {
      const t = await activeTab();
      checkTab(t);
      runLater(() => startGuide(t), 'Step guide');
      return { ok: true };
    }
    case 'guideStop':
      runLater(() => stopGuide(true), 'Step guide');
      return { ok: true };
    case 'guideStatus':
      await guideReady;
      return { ok: true, guide };
    case 'guidePause':
      await guideReady;
      guide.paused = !!msg.paused;
      saveGuide();
      return { ok: true };
    case 'guideState': {
      await guideReady;
      const s = await getSettings();
      const mine = sender.tab && guide.active && guide.tabId === sender.tab.id;
      return { ok: true, active: !!mine, paused: guide.paused, count: guide.count, typing: s.guideTyping, values: s.guideValues };
    }
    case 'guideClick': {
      await guideReady;
      if (!sender.tab || !guide.active || guide.paused || guide.tabId !== sender.tab.id) return { ok: false, error: 'not recording' };
      const s = await getSettings();
      const dataUrl = await captureTab(sender.tab);
      guide.count++;
      saveGuide();
      const count = guide.count;
      const batch = guide.batch || 'none';
      guideChain = guideChain.then(() => guideStep(sender.tab, dataUrl, { ...msg, n: count }, s, batch)).catch((e) => console.error(e));
      return { ok: true, count };
    }

    case 'openManual':
      if (DOC_NAMES[msg.doc]) await setActiveDoc(msg.doc); // open it on the document something was just added to
      await chrome.tabs.create({ url: chrome.runtime.getURL('manual/manual.html') });
      return { ok: true };
    case 'addCaptureTo':
      return addCaptureTo(msg.id, msg.doc);
    case 'openOptions':
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    case 'openRecorder':
      await openRecorder(null, msg.shot);
      return { ok: true };
    case 'recClicks': {
      // click ripples in the recorded tab
      await chrome.storage.session.set({ evkClicks: msg.on ? msg.tabId : null }).catch(() => {});
      if (msg.on) await setRecOwner(sender);
      if (msg.tabId != null) await injectClicks(msg.tabId, !!msg.on);
      return { ok: true };
    }
    case 'recStepsStart':
      await recReady;
      rec = { active: true, tabId: msg.tabId, shots: msg.shots !== false, values: !!msg.values, paused: false, n: 0, screen: !!msg.screen, outside: false, geoScreen: null, insets: {} };
      saveRec();
      await setRecOwner(sender);
      if (msg.tabId != null) await injectRecSteps(msg.tabId);
      if (rec.screen) { // screen / window: the tab in front of every window counts too
        for (const t of await chrome.tabs.query({ active: true, windowType: 'normal' })) { pageGeo(t); if (t.id !== msg.tabId) followRecTab(t); }
      }
      return { ok: true };
    case 'recStepsPause':
      await recReady;
      rec.paused = !!msg.paused;
      saveRec();
      return { ok: true };
    case 'recStepsStop':
      await stopRecSteps();
      return { ok: true };
    case 'recStepsState':
      await recReady;
      return { ok: true, active: !!(sender.tab && rec.active && (rec.screen || rec.tabId === sender.tab.id)), values: rec.values, typing: true };
    case 'recStep':
      if (!sender.tab) return { ok: false };
      return await onRecStep(sender.tab, msg);
    case 'focusTab':
      if (msg.tabId != null) {
        const t = await chrome.tabs.get(msg.tabId).catch(() => null);
        if (t) { await chrome.windows.update(t.windowId, { focused: true }).catch(() => {}); await chrome.tabs.update(t.id, { active: true }).catch(() => {}); }
      }
      return { ok: true };
    case 'closeTab':
      if (sender.tab) chrome.tabs.remove(sender.tab.id);
      return { ok: true };
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || msg.target === 'offscreen') return;
  (async () => {
    try {
      const r = await handle(msg, sender);
      if (r !== undefined) send(r);
    } catch (e) {
      send({ ok: false, error: (e && e.message) || String(e) });
    }
  })();
  return true;
});

// Used by the local Playwright smoke test (service-worker console): self.__evk.doCapture('full')
self.__evk = { doCapture, splitCapture, getSettings, rec: () => rec, pageGeo };
