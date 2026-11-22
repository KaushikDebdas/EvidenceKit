// Stores the console / network entries reported by the in-page hooks, per tab.
// Kept in memory, with a copy in IndexedDB (kv store, key "hooks:<tabId>") so the logs survive when Chrome
// stops this worker. Only tabs that changed are written, at most every 2 s. (chrome.storage.session was used
// before: its 10 MB limit filled up with many tabs, and every write copied the logs of every tab.)
import { dbPut, dbAll, dbDel } from './db.js';

const tabs = new Map(); // tabId -> { startedAt, pageUrl, console: [], network: [] }
const MAX_CONSOLE = 1000;
const MAX_NET = 1500;
const KEY = 'hooks:';
const SESSION_MARK = 'evkHooksIdb'; // in storage.session: gone after a browser restart, when tab ids start over

const ready = (async () => {
  try {
    chrome.storage.session.remove('qaepHooks').catch(() => {}); // old format (before the rename to EvidenceKit)
    const mark = await chrome.storage.session.get(SESSION_MARK);
    const saved = (await dbAll('kv')).filter((r) => typeof r.key === 'string' && r.key.startsWith(KEY));
    if (mark[SESSION_MARK]) {
      for (const r of saved) if (!tabs.has(+r.key.slice(KEY.length))) tabs.set(+r.key.slice(KEY.length), r.value);
    } else {
      // new browser session: logs from the last one belong to tabs that no longer exist
      await Promise.all(saved.map((r) => dbDel('kv', r.key).catch(() => {})));
      await chrome.storage.session.set({ [SESSION_MARK]: true });
    }
  } catch (e) {}
})();

const dirty = new Set();
let timer = null;
function persist(tabId) {
  dirty.add(tabId);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const ids = [...dirty];
    dirty.clear();
    for (const id of ids) {
      const t = tabs.get(id);
      if (t) dbPut('kv', { key: KEY + id, value: t }).catch(() => {});
    }
  }, 2000);
}

function ensure(tabId) {
  let t = tabs.get(tabId);
  if (!t) { t = { startedAt: Date.now(), pageUrl: '', console: [], network: [] }; tabs.set(tabId, t); }
  return t;
}

export async function onPage(tabId, url, keep) {
  await ready;
  const t = ensure(tabId);
  if (!keep) { t.console = []; t.network = []; }
  else t.console.push({ ts: Date.now(), level: 'info', text: `— Navigated to ${url} —` });
  t.startedAt = Date.now();
  t.pageUrl = url;
  persist(tabId);
}

export async function onBatch(tabId, batch) {
  await ready;
  const t = ensure(tabId);
  for (const { kind, data } of batch) {
    if (kind === 'console') {
      t.console.push({ ts: data.ts, level: data.level === 'warn' || data.level === 'error' || data.level === 'info' || data.level === 'debug' ? data.level : 'log', text: String(data.text || '') });
      if (t.console.length > MAX_CONSOLE) t.console.splice(0, t.console.length - MAX_CONSOLE);
    } else if (kind === 'net') {
      if (data.phase === 'start') {
        t.network.push({ id: data.id, ts: data.ts, method: data.method, url: String(data.url).slice(0, 1500), type: data.type, status: 0 });
      } else if (data.phase === 'end') {
        let e = null;
        for (let i = t.network.length - 1, n = 0; i >= 0 && n < 300; i--, n++) if (t.network[i].id === data.id) { e = t.network[i]; break; }
        if (e) {
          e.status = data.status || 0;
          e.statusText = data.statusText;
          e.duration = data.duration;
          e.mime = data.mime;
          if (data.failed) { e.failed = true; e.error = data.error; }
        }
      } else if (data.phase === 'resource') {
        t.network.push({ id: data.id, ts: data.ts, method: 'GET', url: String(data.url).slice(0, 1500), type: data.type, status: data.status, duration: data.duration, size: data.size });
      }
      if (t.network.length > MAX_NET) t.network.splice(0, t.network.length - MAX_NET);
    }
  }
  persist(tabId);
}

export async function status(tabId) {
  await ready;
  const t = tabs.get(tabId);
  if (!t) return { hooked: false, console: 0, errors: 0, network: 0, failed: 0 };
  return {
    hooked: true,
    console: t.console.length,
    errors: t.console.filter((e) => e.level === 'error').length,
    network: t.network.length,
    failed: t.network.filter((e) => e.failed || e.status >= 400).length,
  };
}

export async function snapshot(tabId) {
  await ready;
  const t = tabs.get(tabId);
  if (!t) return null;
  const network = t.network.map((e) => ({ ...e })).sort((a, b) => a.ts - b.ts);
  return { startedAt: t.startedAt, active: true, source: 'page', console: t.console.slice(), network };
}

export async function clear(tabId) {
  await ready;
  const t = tabs.get(tabId);
  if (t) { t.console = []; t.network = []; persist(tabId); }
}

export async function remove(tabId) {
  await ready; // otherwise a worker that just woke up would load this tab's logs again afterwards
  tabs.delete(tabId);
  dirty.delete(tabId);
  await dbDel('kv', KEY + tabId).catch(() => {});
}
