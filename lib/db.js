// Tiny IndexedDB wrapper shared by background, editor and manual pages.
const DB_NAME = 'evidencekit';
const DB_VER = 1;
const STORES = { captures: 'id', steps: 'id', kv: 'key' };
// Before the rename to EvidenceKit the database was called "qa-evidence-pro". The first time the new one is
// opened, everything in the old one (captures, manual steps, logo, save folder …) is copied over, then the
// old database is deleted.
const OLD_DB_NAME = 'qa-evidence-pro';
const MIGRATED_KEY = '_migratedFromOldDb';
let dbp = null;

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// create = false: resolves null when the database does not exist (and does not create it)
function openDb(name, create) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, create ? DB_VER : undefined);
    req.onupgradeneeded = (e) => {
      if (!create) { if (e.oldVersion === 0) req.transaction.abort(); return; }
      const db = req.result;
      for (const [name2, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name2)) db.createObjectStore(name2, { keyPath });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); if (name === DB_NAME) dbp = null; };
      resolve(db);
    };
    req.onerror = () => (!create && req.error && req.error.name === 'AbortError' ? resolve(null) : reject(req.error));
  });
}

async function migrateOld(db) {
  const old = await openDb(OLD_DB_NAME, false);
  if (!old) return;
  try {
    for (const store of Object.keys(STORES)) {
      if (!old.objectStoreNames.contains(store)) continue;
      const rows = await reqP(old.transaction(store).objectStore(store).getAll());
      if (!rows.length) continue;
      await new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        const st = tx.objectStore(store);
        for (const r of rows) st.put(r);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
    }
  } finally {
    old.close();
  }
  indexedDB.deleteDatabase(OLD_DB_NAME); // completes on its own once nothing else has it open
}

// Every page and the service worker open the database; the lock makes sure only one of them copies the old
// data and that nobody reads the new database before the copy is complete.
function withLock(fn) {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('evidencekit-db-open', fn) : fn();
}

function open() {
  if (dbp) return dbp;
  dbp = withLock(async () => {
    const db = await openDb(DB_NAME, true);
    const done = await reqP(db.transaction('kv').objectStore('kv').get(MIGRATED_KEY));
    if (!done) {
      try {
        await migrateOld(db);
        await reqP(db.transaction('kv', 'readwrite').objectStore('kv').put({ key: MIGRATED_KEY, value: Date.now() }));
      } catch (e) {
        console.error('EvidenceKit: copying data from the old database failed (will retry next time)', e);
      }
    }
    return db;
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const st = tx.objectStore(store);
        const req = fn(st);
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export const dbPut = (store, val) => run(store, 'readwrite', (s) => s.put(val));
export const dbGet = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const dbAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const dbDel = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
export const dbClear = (store) => run(store, 'readwrite', (s) => s.clear());
// saves only if the record is still there (in one transaction): a late save must never bring back a deleted step
export const dbPutIfExists = (store, val) => run(store, 'readwrite', (s) => {
  const r = s.getKey(val[s.keyPath]);
  r.onsuccess = () => { if (r.result !== undefined) s.put(val); };
  return r;
});
export const dbPutMany = (store, vals) => run(store, 'readwrite', (s) => { vals.forEach((v) => s.put(v)); return null; });
export const dbDelMany = (store, keys) => run(store, 'readwrite', (s) => { keys.forEach((k) => s.delete(k)); return null; });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function getSteps() {
  const all = await dbAll('steps');
  return all.sort((a, b) => a.order - b.order);
}
